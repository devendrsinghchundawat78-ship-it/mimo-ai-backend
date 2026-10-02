import https from 'node:https';
import type { AIRequest, AIResult } from '../ai/types.js';
import type { AIRouter } from '../ai/router.js';
import type { AIUsage } from './aiUsage.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redact } from '../ai/providerError.js';
import { detectPlatform, extractPageData, fetchPlatformOEmbed, fetchPublicPage, validateURL, resolveSafeIp, type FetchOpts, type OEmbedMetadata } from './urlProcessor.js';

export interface Evidence {
  platform: string;
  canonicalUrl: string;
  title?: string;
  author?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  publishedAt?: string;
  keywords?: string[];
  durationSeconds?: number;
  pageText: string;
  videoUrl?: string;
  videoInline?: { mimeType: string; data: string };
  hasLoginWall: boolean;
  sources: string[];
  level: 'full' | 'metadata' | 'none';
}

const CODE_MARKERS = ['WIZ_global_data', 'ytcfg', 'ytInitialData', 'window.__', '(function(', 'var _', '"use strict"', 'function(', '=>{', 'document.', 'self.__'];

// True when text is script/bootstrap code and not human prose.
export function looksLikeCode(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 6000);
  if (CODE_MARKERS.some(m => head.includes(m))) return true;
  const symbols = (head.match(/[{}();=<>\[\]\\]/g) ?? []).length;
  return head.length > 200 && symbols / head.length > 0.08;
}

export function youtubeId(u: URL): string | undefined {
  const host = u.hostname.toLowerCase();
  let id: string | undefined;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host.endsWith('youtube.com')) {
    if (u.pathname === '/watch') id = u.searchParams.get('v') ?? undefined;
    else { const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,20})/); id = m?.[1]; }
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : undefined;
}

// Reads public player metadata (description, keywords, length) embedded in a YouTube watch page. No login, no captions download.
export function parseYouTubePlayer(html: string): { description?: string; keywords?: string[]; durationSeconds?: number; author?: string; title?: string } {
  const str = (key: string): string | undefined => {
    const m = html.match(new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)"'));
    if (!m) return undefined;
    try { return JSON.parse('"' + m[1] + '"') as string; } catch { return undefined; }
  };
  const kw = html.match(/"keywords":\[((?:"(?:[^"\\]|\\.)*"(?:,)?)*)\]/);
  let keywords: string[] | undefined;
  if (kw) { try { keywords = JSON.parse('[' + kw[1] + ']') as string[]; } catch { /* ignore */ } }
  const len = str('lengthSeconds');
  return { description: str('shortDescription'), keywords, durationSeconds: len ? Number(len) || undefined : undefined, author: str('author'), title: str('title') };
}

async function tryFetch(raw: string, opts: FetchOpts): Promise<{ html: string; finalUrl: string } | undefined> {
  try { return await fetchPublicPage(raw, 0, opts); }
  catch (error) {
    const code = error instanceof AppError ? error.code : (error as { code?: string })?.code ?? 'FETCH_ERROR';
    logger.warn({ event: 'page_fetch_failed', errorCode: code, errorMessage: redact(String((error as Error)?.message ?? '')).slice(0, 200) });
    return undefined;
  }
}


// Public embeds only. No session, private APIs, proxy, challenge bypass or URL logging.
export function instagramEmbedUrl(u: URL): string | undefined {
  if (!['instagram.com', 'www.instagram.com'].includes(u.hostname.toLowerCase())) return undefined;
  const m = u.pathname.match(/^\/(?:reel|reels|p)\/([A-Za-z0-9_-]{5,40})\/?$/);
  return m ? `https://www.instagram.com/p/${m[1]}/embed/` : undefined;
}
export function instagramMediaUrl(html: string): string | undefined {
  // Embed data is often JSON serialized inside another JSON string.
  const flat = html.replace(/\\"/g, '"');
  const match = flat.match(/"video_url"\s*:\s*"([^"]+)"/) ?? flat.match(/<meta[^>]+(?:property|name)=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)/i);
  if (!match) return undefined;
  const raw = match[1]!.replace(/\\+\//g, '/').replace(/\\+u0026/g, '&').replace(/\\+u0025/g, '%').replace(/&amp;/g, '&');
  try { const u = validateURL(raw); return u.hostname.endsWith('.cdninstagram.com') ? u.href : undefined; } catch { return undefined; }
}
export async function downloadInstagramVideo(raw: string): Promise<{ mimeType: string; data: string }> {
  const u = validateURL(raw);
  if (!u.hostname.endsWith('.cdninstagram.com')) throw new AppError(422, 'VIDEO_HOST_UNSUPPORTED', 'Not an Instagram media host');
  const ip = await resolveSafeIp(u.hostname);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const req = https.get(u, {
      headers: { 'User-Agent': 'MimoLinkPreview/1.0', 'Accept': 'video/mp4' },
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: any[]) => void) => o?.all ? cb(null, [ip]) : cb(null, ip.address, ip.family)) as any
    }, res => {
      // Do not follow media redirects or forward any cookies.
      if (res.statusCode !== 200 || !(res.headers['content-type'] ?? '').includes('video/mp4')) {
        res.resume(); reject(new AppError(422, 'VIDEO_UNAVAILABLE', 'Public video unavailable')); return;
      }
      const max = 12 * 1024 * 1024;
      if (Number(res.headers['content-length'] ?? 0) > max) { res.resume(); reject(new AppError(413, 'VIDEO_TOO_LARGE', 'Video exceeds inline budget')); return; }
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > max) res.destroy(new AppError(413, 'VIDEO_TOO_LARGE', 'Video exceeds inline budget')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const timer = setTimeout(() => req.destroy(new AppError(504, 'VIDEO_TIMEOUT', 'Public media download timed out')), 15000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
  });
  if (bytes.length < 12 || bytes.subarray(4, 8).toString() !== 'ftyp') throw new AppError(422, 'VIDEO_INVALID', 'Not an MP4 file');
  return { mimeType: 'video/mp4', data: bytes.toString('base64') };
}

export async function collectEvidence(rawUrl: string): Promise<Evidence> {
  const url = validateURL(rawUrl);
  const platform = detectPlatform(url);
  const isYouTube = platform === 'YouTube' || platform === 'YouTube Shorts';
  const isInstagram = platform === 'Instagram';
  const sources: string[] = [];

  const oembed: OEmbedMetadata | null = await fetchPlatformOEmbed(url, platform);
  if (oembed) sources.push('oembed');

  const opts: FetchOpts = isYouTube ? { cookie: 'CONSENT=YES+1; SOCS=CAI' } : isInstagram ? { userAgent: 'MimoLinkPreview/1.0' } : {};
  const page = await tryFetch(url.href, opts);

  let title = oembed?.title, author = oembed?.author, description: string | undefined, siteName = oembed?.provider, imageUrl = oembed?.thumbnail;
  let publishedAt: string | undefined, canonicalUrl = url.href, pageText = '', hasLoginWall = false;
  let keywords: string[] | undefined, durationSeconds: number | undefined;

  if (page) {
    const ex = extractPageData(page.html, page.finalUrl, oembed);
    const og = ex.metadata;
    // Instagram login page has a generic title; do not treat it as content.
    const genericTitle = !og.title || /^(instagram|youtube|login)$/i.test(og.title.trim());
    if (!genericTitle) { title = og.title ?? title; }
    description = og.description || undefined;
    author = og.author ?? author; siteName = og.siteName ?? siteName; imageUrl = og.imageUrl ?? imageUrl; publishedAt = og.publishedAt;
    canonicalUrl = ex.canonicalUrl || canonicalUrl;
    hasLoginWall = ex.hasLoginWall;
    if (description || !genericTitle) sources.push('page-meta');
    if (isYouTube) {
      const yt = parseYouTubePlayer(page.html);
      if (yt.description) { description = yt.description.slice(0, 4000); sources.push('youtube-public-description'); }
      keywords = yt.keywords?.slice(0, 20); durationSeconds = yt.durationSeconds; author = yt.author ?? author; title = yt.title ?? title;
    } else if (!isInstagram && !looksLikeCode(ex.pageText) && !ex.hasLoginWall) {
      pageText = ex.pageText;
      if (pageText.length > 80) sources.push('page-text');
    }
  }
  if (isInstagram && /^\s*(log ?in|sign ?up)/i.test(title ?? '')) title = undefined;

  let videoInline: Evidence['videoInline'];
  const embedUrl = isInstagram ? instagramEmbedUrl(url) : undefined;
  if (embedUrl) {
    try {
      const embed = await fetchPublicPage(embedUrl, 0, { userAgent: 'MimoLinkPreview/1.0' });
      if (!embed.finalUrl.includes('/embed/')) throw new AppError(422, 'EMBED_LOGIN_WALL', 'Embed redirected');
      const mediaUrl = instagramMediaUrl(embed.html);
      if (mediaUrl) {
        videoInline = await downloadInstagramVideo(mediaUrl);
        sources.push('instagram-public-embed-video');
        logger.info({ event: 'instagram_video_extracted', bytes: Math.floor(videoInline.data.length * 3 / 4) });
      } else logger.info({ event: 'instagram_video_unavailable', errorCode: 'NO_PUBLIC_MEDIA' });
    } catch (error) {
      logger.warn({ event: 'instagram_video_unavailable', errorCode: error instanceof AppError ? error.code : 'PUBLIC_FETCH_FAILED' });
    }
  }
  const id = isYouTube ? youtubeId(url) : undefined;
  const videoUrl = id ? `https://www.youtube.com/watch?v=${id}` : undefined;
  if (description && looksLikeCode(description)) description = undefined;
  if (title && looksLikeCode(title)) title = undefined;

  const hasMeta = !!(title || description || author);
  const level: Evidence['level'] = (pageText.length > 300 || (description && description.length > 200)) ? 'full' : (hasMeta || videoUrl ? 'metadata' : 'none');
  return { platform, canonicalUrl, title: title?.slice(0, 500), author, description: description?.slice(0, 4000), siteName, imageUrl, publishedAt, keywords, durationSeconds, pageText: pageText.slice(0, 16000), videoUrl, videoInline, hasLoginWall, sources, level };
}

export const STYLE_RULES = `Write like a rich link-preview card, in the same language as the content (Hinglish stays Hinglish):
- "summary": a one or two sentence overview, then a blank line, then 3 to 6 lines. Each line starts with one fitting emoji, then a short title, a colon, and one specific detail (what is shown, who says what, key facts, numbers, names). Separate lines with \\n.
- Only state things you can see or read in the supplied evidence or the attached video. Never invent names, quotes, lyrics, scenes or numbers.
- If the evidence is only metadata (title, creator, description), say so in one short line at the end of the summary (for example "Only the title and description were available.") and keep the bullets to what that metadata supports.
- Never answer with generic filler such as "Interesting video" or "Useful information".`;

export function evidencePayload(e: Evidence, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: e.canonicalUrl, platform: e.platform,
    metadata: { title: e.title, creator: e.author, description: e.description, siteName: e.siteName, publishedAt: e.publishedAt, keywords: e.keywords, durationSeconds: e.durationSeconds },
    pageText: e.pageText || undefined, evidenceSources: e.sources, hasLoginWall: e.hasLoginWall, ...extra
  });
}

// Runs the AI with the public video attached when available. If the video route fails (private video, unsupported, timeout), reruns with metadata only.
export async function runWithOptionalVideo(usage: AIUsage, router: AIRouter, e: Evidence, make: (videoAttached: boolean) => AIRequest): Promise<{ result: AIResult; videoAttached: boolean }> {
  if (e.videoUrl || e.videoInline) {
    const r = { ...make(true), videoUrl: e.videoUrl, videoInline: e.videoInline, timeoutMs: 60000 };
    try { return { result: await usage.run(r, () => router.run(r)), videoAttached: true }; }
    catch (error) {
      if (error instanceof AppError && (error.code === 'AI_QUOTA_OR_BUSY' || error.code === 'AI_BUSY')) throw error;
      logger.warn({ event: 'video_analysis_failed_using_metadata', errorCode: error instanceof AppError ? error.code : 'UNKNOWN' });
    }
  }
  const r = make(false);
  return { result: await usage.run(r, () => router.run(r)), videoAttached: false };
}

export function stripCodeFences(text: string): string { return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); }
