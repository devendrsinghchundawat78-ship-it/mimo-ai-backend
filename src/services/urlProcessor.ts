import { lookup } from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { load } from 'cheerio';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import type { AIRouter } from '../ai/router.js';
import type { AIUsage } from './aiUsage.js';
import type { LinkDetailsResponse, LinkMetadata, LinkAnalysis } from '../ai/types.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redact } from '../ai/providerError.js';

export const linkAnalysisSchema = z.object({
  title: z.string().max(500),
  summary: z.string().max(12000),
  key_takeaways: z.array(z.string().max(1000)).min(1).max(10),
  topics: z.array(z.string().max(100)).max(15),
  tags: z.array(z.string().max(80)).max(20),
  content_type: z.string().max(100),
  entities: z.array(z.object({
    name: z.string().max(150),
    type: z.string().max(80)
  })).max(20),
  evidence: z.array(z.object({
    claim: z.string().max(500),
    source: z.string().max(200)
  })).max(15),
  suggested_collection: z.string().max(100),
  confidence: z.number().min(0.0).max(1.0)
});

export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    if (ip.range() !== 'unicast') return false;
    // Explicit protection against IPv4 special ranges & IPv4-mapped IPv6
    if (ip.kind() === 'ipv4') {
      const [o0, o1] = (ip as ipaddr.IPv4).octets;
      if (o0 === undefined || o1 === undefined) return false;
      if (o0 === 127 || o0 === 10 || o0 === 0) return false;
      if (o0 === 172 && o1 >= 16 && o1 <= 31) return false;
      if (o0 === 192 && o1 === 168) return false;
      if (o0 === 169 && o1 === 254) return false;
      if (o0 === 100 && o1 >= 64 && o1 <= 127) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function validateURL(raw: string): URL {
  if (!raw || typeof raw !== 'string' || raw.length > 2048) {
    throw new AppError(400, 'INVALID_URL', 'URL is invalid or exceeds 2048 characters');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'Malformed URL');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.hostname === 'localhost' || !u.hostname.includes('.')) {
    throw new AppError(400, 'UNSAFE_URL', 'Only public HTTPS links are supported');
  }
  if (ipaddr.isValid(u.hostname) && !publicAddress(u.hostname)) {
    throw new AppError(400, 'UNSAFE_URL', 'Private network links are blocked');
  }
  return u;
}

export async function resolveSafeIp(hostname: string): Promise<{ address: string; family: number }> {
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new AppError(422, 'FETCH_FAILED', 'Could not resolve domain name');
  }
  if (!records.length || records.some(r => !publicAddress(r.address))) {
    throw new AppError(400, 'UNSAFE_URL', 'Private network links are blocked');
  }
  return records[0]!;
}

export function detectPlatform(url: URL): string {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  if (host.includes('youtube.com') || host.includes('youtu.be')) {
    return path.startsWith('/shorts/') ? 'YouTube Shorts' : 'YouTube';
  }
  if (host.includes('instagram.com')) return 'Instagram';
  if (host.includes('facebook.com') || host.includes('fb.watch')) return 'Facebook';
  if (host.includes('netflix.com')) return 'Netflix';
  if (host.includes('twitter.com') || host.includes('x.com')) return 'X / Twitter';
  if (host.includes('spotify.com')) return 'Spotify';
  if (host.includes('vimeo.com')) return 'Vimeo';
  if (host.includes('amazon.') || host.includes('amzn.')) return 'Amazon';
  if (host.includes('flipkart.com')) return 'Flipkart';
  if (host.includes('reddit.com') || host.includes('redd.it')) return 'Reddit';
  if (host.includes('tiktok.com')) return 'TikTok';
  if (host.includes('linkedin.com')) return 'LinkedIn';
  if (host.includes('github.com')) return 'GitHub';
  if (host.includes('medium.com')) return 'Medium';
  if (host.includes('news') || host.includes('blog') || path.includes('/news/') || path.includes('/article/')) {
    return 'Article';
  }
  return 'Website';
}

export interface OEmbedMetadata {
  title?: string;
  author?: string;
  thumbnail?: string;
  provider?: string;
}

export async function fetchPlatformOEmbed(url: URL, platform: string): Promise<OEmbedMetadata | null> {
  let oembedEndpoint: string | null = null;

  if (platform === 'YouTube' || platform === 'YouTube Shorts') {
    oembedEndpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url.href)}&format=json`;
  } else if (platform === 'Vimeo') {
    oembedEndpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url.href)}`;
  } else if (platform === 'Spotify') {
    oembedEndpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url.href)}`;
  } else if (platform === 'X / Twitter') {
    oembedEndpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url.href)}&omit_script=1`;
  } else if (platform === 'Reddit') {
    oembedEndpoint = `https://www.reddit.com/oembed?url=${encodeURIComponent(url.href)}`;
  }

  if (!oembedEndpoint) return null;

  try {
    const oembedUrl = validateURL(oembedEndpoint);
    const ip = await resolveSafeIp(oembedUrl.hostname);
    const res = await fetch(oembedEndpoint, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MimoAI/1.0)',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return {
      title: typeof data.title === 'string' ? data.title : undefined,
      author: typeof data.author_name === 'string' ? data.author_name : undefined,
      thumbnail: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined,
      provider: typeof data.provider_name === 'string' ? data.provider_name : platform
    };
  } catch {
    return null;
  }
}

export async function fetchPublicPage(raw: string, redirects = 0): Promise<{ html: string; finalUrl: string }> {
  if (redirects > 5) throw new AppError(422, 'REDIRECT_LIMIT', 'Too many redirects');
  const u = validateURL(raw);
  const record = await resolveSafeIp(u.hostname);

  const response = await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = https.get(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 (compatible; MimoAI/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: any[]) => void) => opts?.all ? cb(null, [{ address: record.address, family: record.family }]) : cb(null, record.address, record.family)) as any
    }, res => {
      const status = res.statusCode ?? 500;
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, headers: res.headers, body: '' });
        return;
      }
      if (status !== 200 || !res.headers['content-type']?.includes('text/html')) {
        res.resume();
        reject(new AppError(422, 'CONTENT_UNAVAILABLE', 'Link did not return public HTML'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          res.destroy();
          reject(new AppError(413, 'CONTENT_TOO_LARGE', 'Page is too large'));
        } else {
          chunks.push(chunk);
        }
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });

    const deadline = setTimeout(() => req.destroy(new AppError(504, 'TIMEOUT', 'Page fetch timed out')), 10000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
  });

  if (response.status >= 300 && response.status < 400) {
    if (!response.headers.location) throw new AppError(422, 'REDIRECT_LIMIT', 'Redirect location header missing');
    const nextUrl = new URL(response.headers.location, u).href;
    return fetchPublicPage(nextUrl, redirects + 1);
  }

  return { html: response.body, finalUrl: u.href };
}

export interface ExtractedPageData {
  canonicalUrl: string;
  metadata: LinkMetadata;
  pageText: string;
  hasLoginWall: boolean;
  hasInsufficientEvidence: boolean;
}

export function extractPageData(html: string, finalUrl: string, oembed?: OEmbedMetadata | null): ExtractedPageData {
  const $ = load(html);

  const ogTitle = $('meta[property="og:title"]').attr('content');
  const twitterTitle = $('meta[name="twitter:title"]').attr('content');
  const docTitle = $('title').text().trim();
  const title = (ogTitle || twitterTitle || oembed?.title || docTitle || '').slice(0, 500);

  const ogDesc = $('meta[property="og:description"]').attr('content');
  const twitterDesc = $('meta[name="twitter:description"]').attr('content');
  const metaDesc = $('meta[name="description"]').attr('content');
  const description = (ogDesc || twitterDesc || metaDesc || '').slice(0, 4000);

  const ogImage = $('meta[property="og:image"]').attr('content');
  const twitterImage = $('meta[name="twitter:image"]').attr('content');
  const imageUrl = ogImage || twitterImage || oembed?.thumbnail || undefined;

  const author = $('meta[name="author"]').attr('content') ||
    $('meta[property="article:author"]').attr('content') ||
    oembed?.author || undefined;

  const publishedAt = $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="pubdate"]').attr('content') || undefined;

  const siteName = $('meta[property="og:site_name"]').attr('content') ||
    oembed?.provider || undefined;

  const canonicalUrl = $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    finalUrl;

  // JSON-LD structured data extraction
  let jsonLdSummary: string | undefined;
  try {
    $('script[type="application/ld+json"]').each((_, elem) => {
      if (jsonLdSummary) return;
      try {
        const parsed = JSON.parse($(elem).html() || '{}');
        const item = Array.isArray(parsed) ? parsed[0] : (parsed['@graph'] ? parsed['@graph'][0] : parsed);
        if (item && (item.description || item.headline || item.articleBody)) {
          jsonLdSummary = String(item.articleBody || item.description || item.headline || '').slice(0, 4000);
        }
      } catch { /* ignore invalid json-ld */ }
    });
  } catch { /* ignore */ }

  // Clean accessible page text
  $('script,style,nav,footer,header,noscript,iframe,svg,form,aside,button').remove();
  const rawText = $('article,main').first().text().trim() || $('body').text().trim();
  const pageText = (jsonLdSummary ? `${jsonLdSummary}\n\n${rawText}` : rawText)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24000);

  // Check login wall or bot challenge
  const lowerUrl = finalUrl.toLowerCase();
  const lowerText = pageText.toLowerCase();
  const hasLoginWall = lowerUrl.includes('/accounts/login') ||
    lowerUrl.includes('/login') ||
    lowerText.includes('sign in to continue') ||
    lowerText.includes('log in to instagram') ||
    lowerText.includes('please enable javascript and cookies to continue') ||
    lowerText.includes('verify you are human');

  const hasInsufficientEvidence = !title && !description && pageText.length < 50;

  return {
    canonicalUrl,
    metadata: {
      title: title || undefined,
      description: description || undefined,
      imageUrl,
      author,
      publishedAt,
      siteName
    },
    pageText,
    hasLoginWall,
    hasInsufficientEvidence
  };
}

export class UniversalUrlService {
  constructor(
    private db: SupabaseClient,
    private router: AIRouter,
    private usage: AIUsage,
    private config: Config
  ) {}

  async processUrl(rawUrl: string, userId: string, userJwt: string, saveId?: string): Promise<LinkDetailsResponse> {
    // Step 1: Validate URL & SSRF
    const validated = validateURL(rawUrl);
    const platform = detectPlatform(validated);

    // Step 2: Try Railway Primary Processing
    try {
      const primaryResult = await this.executeRailwayPrimary(validated, platform, userId);

      // Persist to saves.ai_result if saveId provided
      if (saveId) {
        await this.persistSaveResult(userId, saveId, primaryResult.analysis, primaryResult.metadata);
      }

      return primaryResult;
    } catch (primaryError) {
      logger.warn({
        event: 'railway_primary_failed_triggering_supabase_recovery',
        errorCode: primaryError instanceof AppError ? primaryError.code : ((primaryError as { code?: string })?.code ?? 'UNKNOWN'),
        errorName: (primaryError as Error)?.name,
        errorMessage: redact(String((primaryError as Error)?.message ?? '')).slice(0, 300)
      });

      // Step 3: Trigger Supabase AI Recovery Fallback
      const fallbackResult = await this.executeSupabaseFallback(validated.href, platform, userJwt);

      // Persist to saves.ai_result if saveId provided
      if (saveId) {
        await this.persistSaveResult(userId, saveId, fallbackResult.analysis, fallbackResult.metadata);
      }

      return fallbackResult;
    }
  }

  private async executeRailwayPrimary(url: URL, platform: string, userId: string): Promise<LinkDetailsResponse> {
    // 1. Fetch public oEmbed if supported
    const oembed = await fetchPlatformOEmbed(url, platform);

    // 2. Fetch HTML page
    const { html, finalUrl } = await fetchPublicPage(url.href);

    // 3. Extract metadata and text
    const extracted = extractPageData(html, finalUrl, oembed);

    if (extracted.hasInsufficientEvidence) {
      throw new AppError(422, 'INSUFFICIENT_EVIDENCE', 'The page did not expose enough accessible content for reliable analysis');
    }

    // 4. Build AI analysis payload
    const analysisInput = JSON.stringify({
      url: url.href,
      finalUrl,
      platform,
      metadata: extracted.metadata,
      pageText: extracted.pageText.slice(0, 16000),
      hasLoginWall: extracted.hasLoginWall
    });

    const systemPrompt = `You are Mimo AI Universal URL Intelligence.
Analyze the provided webpage metadata and content strictly based on ACTUAL EVIDENCE.
DO NOT hallucinate, invent facts, create generic filler, or guess unseen content.
Never produce generic filler like "Interesting article", "Useful information", or "Entertainment content".

For movie/story/entertainment content:
- Premise and setting
- Main characters and key relationships (if mentioned in text)
- Central conflict and themes
- Evidence-based takeaways

For educational/tutorials/articles:
- Core concepts and conclusions
- Key steps or findings
- Evidence-based takeaways

For products / e-commerce:
- Product name, brand, key specs, use-cases

Confidence scoring:
- 0.8 to 1.0: Full rich page content / article text was accessible and analyzed.
- 0.4 to 0.7: Partial content or primarily metadata (title, description, tags) was accessible.
- 0.0 to 0.3: Very limited metadata, login wall, or minimal evidence.

Return ONLY a valid JSON object matching this schema:
{
  "title": string,
  "summary": string,
  "key_takeaways": string[],
  "topics": string[],
  "tags": string[],
  "content_type": string,
  "entities": [{"name": string, "type": string}],
  "evidence": [{"claim": string, "source": string}],
  "suggested_collection": string,
  "confidence": number
}`;

    const r = {
      userId,
      capability: 'link-details' as const,
      json: true,
      system: systemPrompt,
      messages: [{ role: 'user' as const, content: analysisInput }]
    };

    const aiResult = await this.usage.run(r, () => this.router.run(r));
    const parsedAnalysis = linkAnalysisSchema.parse(JSON.parse(aiResult.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));

    return {
      ok: true,
      url: url.href,
      canonicalUrl: extracted.canonicalUrl,
      platform,
      metadata: extracted.metadata,
      analysis: parsedAnalysis,
      source: 'railway-primary'
    };
  }

  async executeSupabaseFallback(url: string, platform: string, userJwt: string): Promise<LinkDetailsResponse> {
    const recoveryUrl = this.config.SUPABASE_AI_RECOVERY_URL;
    logger.info({ event: 'calling_supabase_ai_recovery' });

    let res: Response;
    try {
      res = await fetch(recoveryUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${userJwt}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(25000)
      });
    } catch (netErr) {
      throw new AppError(503, 'AI_FAILED', 'Both Railway primary and Supabase AI recovery could not be reached');
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      logger.error({ event: 'supabase_recovery_failed', httpStatus: res.status });
      throw new AppError(502, 'AI_FAILED', 'Supabase AI recovery failed to process URL');
    }

    const data = await res.json() as any;
    return this.normalizeSupabaseResponse(data, url, platform);
  }

  normalizeSupabaseResponse(data: any, originalUrl: string, platform: string): LinkDetailsResponse {
    const rawAnalysis = data.analysis || data.result || data;
    const rawMetadata = data.metadata || data;

    const normalizedMetadata: LinkMetadata = {
      title: rawMetadata.title || rawAnalysis.title || undefined,
      description: rawMetadata.description || rawAnalysis.summary || undefined,
      imageUrl: rawMetadata.imageUrl || rawMetadata.image_url || rawMetadata.thumbnail || undefined,
      author: rawMetadata.author || undefined,
      publishedAt: rawMetadata.publishedAt || rawMetadata.published_at || undefined,
      siteName: rawMetadata.siteName || rawMetadata.site_name || platform
    };

    const takeaways: string[] = Array.isArray(rawAnalysis.key_takeaways)
      ? rawAnalysis.key_takeaways.map((t: any) => typeof t === 'string' ? t : (t.title ? `${t.title}: ${t.description || ''}` : JSON.stringify(t)))
      : (Array.isArray(rawAnalysis.usefulInfo) ? rawAnalysis.usefulInfo.map(String) : []);
    const realSummary = String(rawAnalysis.summary || normalizedMetadata.description || '').trim();
    if (!realSummary) throw new AppError(502, 'AI_FAILED', 'Supabase AI recovery returned no content');

    const normalizedAnalysis: LinkAnalysis = {
      title: String(rawAnalysis.title || normalizedMetadata.title || normalizedMetadata.siteName || platform).slice(0, 500),
      summary: realSummary.slice(0, 12000),
      key_takeaways: takeaways.slice(0, 8),
      topics: Array.isArray(rawAnalysis.topics) ? rawAnalysis.topics.map(String).slice(0, 15) : [platform],
      tags: Array.isArray(rawAnalysis.tags) ? rawAnalysis.tags.map(String).slice(0, 20) : [platform.toLowerCase()],
      content_type: String(rawAnalysis.content_type || rawAnalysis.category || 'link'),
      entities: Array.isArray(rawAnalysis.entities)
        ? rawAnalysis.entities.map((e: any) => ({
            name: typeof e === 'string' ? e : String(e.name || 'Entity'),
            type: typeof e === 'string' ? 'concept' : String(e.type || 'general')
          })).slice(0, 20)
        : [],
      evidence: Array.isArray(rawAnalysis.evidence)
        ? rawAnalysis.evidence.map((ev: any) => ({
            claim: String(ev.claim || 'Extracted from page content'),
            source: String(ev.source || originalUrl)
          })).slice(0, 15)
        : [{ claim: 'Extracted from Supabase AI recovery fallback', source: originalUrl }],
      suggested_collection: String(rawAnalysis.suggested_collection || rawAnalysis.suggestedCollection || platform),
      confidence: typeof rawAnalysis.confidence === 'number' ? Math.max(0, Math.min(1, rawAnalysis.confidence)) : 0.6
    };

    return {
      ok: true,
      url: originalUrl,
      canonicalUrl: data.canonicalUrl || data.canonical_url || originalUrl,
      platform: data.platform || platform,
      metadata: normalizedMetadata,
      analysis: normalizedAnalysis,
      source: 'supabase-ai-fallback'
    };
  }

  private async persistSaveResult(userId: string, saveId: string, analysis: LinkAnalysis, metadata: LinkMetadata) {
    try {
      const { data: save } = await this.db
        .from('saves')
        .select('id, user_id, title')
        .eq('id', saveId)
        .eq('user_id', userId)
        .maybeSingle();

      if (!save) return;

      const updates: Record<string, any> = {
        ai_result: analysis
      };

      if (!save.title && (analysis.title || metadata.title)) {
        updates.title = analysis.title || metadata.title;
      }

      await this.db.from('saves').update(updates).eq('id', saveId).eq('user_id', userId);
    } catch (e) {
      logger.error({ event: 'persist_save_result_failed', errorName: e instanceof Error ? e.name : 'UNKNOWN', saveId });
    }
  }
}
