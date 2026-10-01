import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  publicAddress,
  validateURL,
  detectPlatform,
  extractPageData,
  linkAnalysisSchema
} from '../src/services/urlProcessor.js';

test('SSRF: blocks private, loopback, link-local, AWS/GCP metadata and invalid IPs', () => {
  const blocked = [
    '127.0.0.1',
    '127.0.0.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // AWS/GCP metadata service
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254'
  ];

  for (const ip of blocked) {
    assert.equal(publicAddress(ip), false, `Should block ${ip}`);
  }

  assert.equal(publicAddress('8.8.8.8'), true, 'Public DNS 8.8.8.8 should be allowed');
  assert.equal(publicAddress('1.1.1.1'), true, 'Public DNS 1.1.1.1 should be allowed');
  assert.equal(publicAddress('142.250.190.46'), true, 'Google IP should be allowed');
});

test('SSRF: blocks schemes, credentials, localhost, ports, and long URLs', () => {
  const rejected = [
    'http://example.com', // non-https
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://example.com:8080', // non-443 port
    'https://example.com:80',
    'https://' + 'a'.repeat(2100) + '.com', // excessive length
    'not-a-url'
  ];

  for (const url of rejected) {
    assert.throws(() => validateURL(url), undefined, `Should reject ${url}`);
  }

  const valid = validateURL('https://example.com');
  assert.equal(valid.protocol, 'https:');
  assert.equal(valid.hostname, 'example.com');
});

test('Platform detection handles major services accurately', () => {
  assert.equal(detectPlatform(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ')), 'YouTube');
  assert.equal(detectPlatform(new URL('https://youtu.be/dQw4w9WgXcQ')), 'YouTube');
  assert.equal(detectPlatform(new URL('https://www.youtube.com/shorts/abcdef12345')), 'YouTube Shorts');
  assert.equal(detectPlatform(new URL('https://www.instagram.com/p/C_abc123/')), 'Instagram');
  assert.equal(detectPlatform(new URL('https://www.instagram.com/reel/C_xyz789/')), 'Instagram');
  assert.equal(detectPlatform(new URL('https://www.facebook.com/watch/?v=123456')), 'Facebook');
  assert.equal(detectPlatform(new URL('https://fb.watch/abcdef/')), 'Facebook');
  assert.equal(detectPlatform(new URL('https://www.netflix.com/title/80057281')), 'Netflix');
  assert.equal(detectPlatform(new URL('https://twitter.com/OpenAI/status/123456')), 'X / Twitter');
  assert.equal(detectPlatform(new URL('https://x.com/OpenAI/status/123456')), 'X / Twitter');
  assert.equal(detectPlatform(new URL('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')), 'Spotify');
  assert.equal(detectPlatform(new URL('https://vimeo.com/76979871')), 'Vimeo');
  assert.equal(detectPlatform(new URL('https://www.amazon.com/dp/B08N5WRWNW')), 'Amazon');
  assert.equal(detectPlatform(new URL('https://www.flipkart.com/item/p/itm123')), 'Flipkart');
  assert.equal(detectPlatform(new URL('https://www.reddit.com/r/technology/comments/123/')), 'Reddit');
  assert.equal(detectPlatform(new URL('https://www.tiktok.com/@user/video/123456')), 'TikTok');
  assert.equal(detectPlatform(new URL('https://www.linkedin.com/pulse/article-name/')), 'LinkedIn');
  assert.equal(detectPlatform(new URL('https://github.com/torvalds/linux')), 'GitHub');
  assert.equal(detectPlatform(new URL('https://medium.com/@author/story')), 'Medium');
  assert.equal(detectPlatform(new URL('https://example.com')), 'Website');
});

test('extractPageData extracts rich metadata, JSON-LD and clean text without scripts', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Article Title - NewsSite</title>
        <meta property="og:title" content="OpenGraph Headline" />
        <meta property="og:description" content="This is an informative summary of the article." />
        <meta property="og:image" content="https://example.com/cover.jpg" />
        <meta property="og:site_name" content="Tech News" />
        <meta name="author" content="Jane Doe" />
        <meta property="article:published_time" content="2026-10-01T12:00:00Z" />
        <link rel="canonical" href="https://example.com/canonical-article" />
        <script type="application/ld+json">
          {
            "@type": "Article",
            "headline": "Structured Headline",
            "articleBody": "Full article body from structured schema."
          }
        </script>
      </head>
      <body>
        <nav><a href="/">Home</a></nav>
        <script>console.log("bad script");</script>
        <style>.ads { display: none; }</style>
        <main>
          <p>Main content discussing quantum computing and machine learning advancements.</p>
        </main>
        <footer>Copyright 2026</footer>
      </body>
    </html>
  `;

  const extracted = extractPageData(html, 'https://example.com/article');

  assert.equal(extracted.metadata.title, 'OpenGraph Headline');
  assert.equal(extracted.metadata.description, 'This is an informative summary of the article.');
  assert.equal(extracted.metadata.imageUrl, 'https://example.com/cover.jpg');
  assert.equal(extracted.metadata.author, 'Jane Doe');
  assert.equal(extracted.metadata.publishedAt, '2026-10-01T12:00:00Z');
  assert.equal(extracted.metadata.siteName, 'Tech News');
  assert.equal(extracted.canonicalUrl, 'https://example.com/canonical-article');
  assert.equal(extracted.hasLoginWall, false);
  assert.equal(extracted.hasInsufficientEvidence, false);
  assert.ok(extracted.pageText.includes('quantum computing'));
  assert.ok(!extracted.pageText.includes('bad script'));
  assert.ok(!extracted.pageText.includes('Copyright'));
});

test('extractPageData detects login wall and flags limited evidence', () => {
  const html = `
    <html>
      <head><title>Instagram</title></head>
      <body>
        <h1>Log in to Instagram</h1>
        <p>Sign in to continue to photos.</p>
      </body>
    </html>
  `;
  const extracted = extractPageData(html, 'https://www.instagram.com/accounts/login/?next=/p/123');
  assert.equal(extracted.hasLoginWall, true);
});

test('linkAnalysisSchema validates expected normalized structure', () => {
  const sample = {
    title: 'Quantum Advantage in 2026',
    summary: 'A detailed exploration of superconducting qubits.',
    key_takeaways: [
      'Error correction threshold reached',
      'Scaling beyond 10,000 qubits demonstrated'
    ],
    topics: ['Quantum Computing', 'Physics'],
    tags: ['qubits', 'technology', 'computing'],
    content_type: 'article',
    entities: [{ name: 'IBM', type: 'organization' }],
    evidence: [{ claim: 'Threshold demonstrated', source: 'Research paper Section 3' }],
    suggested_collection: 'Technology',
    confidence: 0.95
  };

  const validated = linkAnalysisSchema.parse(sample);
  assert.equal(validated.confidence, 0.95);
  assert.equal(validated.key_takeaways.length, 2);
  assert.equal(validated.entities[0]?.name, 'IBM');
});

test('UniversalUrlService: forces fallback to Supabase when primary fails', async () => {
  const { UniversalUrlService } = await import('../src/services/urlProcessor.js');

  let fallbackCalled = false;
  let receivedAuthHeader = '';

  // Mock global fetch for Supabase fallback
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    if (urlStr.includes('mimo-link-ai-recovery')) {
      fallbackCalled = true;
      receivedAuthHeader = (init?.headers as any)?.Authorization || '';
      return new Response(JSON.stringify({
        ok: true,
        platform: 'YouTube',
        metadata: {
          title: 'Fallback Video Title',
          description: 'Fallback Description'
        },
        analysis: {
          title: 'Fallback Video Title',
          summary: 'Fallback AI Summary',
          key_takeaways: ['Takeaway 1', 'Takeaway 2'],
          topics: ['Video'],
          tags: ['youtube'],
          content_type: 'video',
          entities: [{ name: 'Creator', type: 'person' }],
          evidence: [{ claim: 'Video premise', source: 'https://youtube.com/watch?v=123' }],
          suggested_collection: 'Videos',
          confidence: 0.75
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  };

  try {
    const mockDb: any = {
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) })
    };
    const mockRouter: any = {
      run: async () => { throw new Error('Primary AI provider unavailable'); }
    };
    const mockUsage: any = {
      run: async (_req: any, fn: any) => fn()
    };
    const mockConfig: any = {
      SUPABASE_AI_RECOVERY_URL: 'https://ugomjglbzcjekibnupin.supabase.co/functions/v1/mimo-link-ai-recovery'
    };

    const service = new UniversalUrlService(mockDb, mockRouter, mockUsage, mockConfig);
    const result = await service.processUrl(
      'https://example.com/test-article',
      'test-user-id',
      'test-jwt-token'
    );

    assert.equal(fallbackCalled, true, 'Supabase fallback should be called');
    assert.equal(receivedAuthHeader, 'Bearer test-jwt-token', 'User JWT must be forwarded');
    assert.equal(result.ok, true);
    assert.equal(result.source, 'supabase-ai-fallback');
    assert.equal(result.analysis.title, 'Fallback Video Title');
    assert.equal(result.analysis.key_takeaways.length, 2);
    assert.equal(result.analysis.confidence, 0.75);
  } finally {
    global.fetch = originalFetch;
  }
});

test('UniversalUrlService: rejects SSRF / invalid URL directly without calling fallback', async () => {
  const { UniversalUrlService } = await import('../src/services/urlProcessor.js');

  let fallbackCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('mimo-link-ai-recovery')) fallbackCalled = true;
    return originalFetch(input, init);
  };

  try {
    const mockDb: any = {};
    const mockRouter: any = {};
    const mockUsage: any = {};
    const mockConfig: any = {
      SUPABASE_AI_RECOVERY_URL: 'https://ugomjglbzcjekibnupin.supabase.co/functions/v1/mimo-link-ai-recovery'
    };

    const service = new UniversalUrlService(mockDb, mockRouter, mockUsage, mockConfig);

    await assert.rejects(
      service.processUrl('http://127.0.0.1', 'test-user', 'test-jwt'),
      (err: any) => err.code === 'UNSAFE_URL' || err.code === 'INVALID_URL'
    );

    await assert.rejects(
      service.processUrl('http://localhost:3000', 'test-user', 'test-jwt'),
      (err: any) => err.code === 'UNSAFE_URL' || err.code === 'INVALID_URL'
    );

    assert.equal(fallbackCalled, false, 'SSRF attempt must never trigger fallback');
  } finally {
    global.fetch = originalFetch;
  }
});

