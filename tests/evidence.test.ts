import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCode, youtubeId, parseYouTubePlayer } from '../src/services/evidence.js';
import { normalizeAnalysis } from '../src/services/urlProcessor.js';

test('looksLikeCode flags bootstrap blobs but not prose', () => {
  assert.equal(looksLikeCode('var WIZ_global_data = {"a":1};window.ytcfg.set({x:1});'), true);
  assert.equal(looksLikeCode('A short film about two friends who open a tiny bakery in Jaipur and the trouble that follows.'), false);
});
test('youtubeId handles watch, youtu.be and shorts', () => {
  assert.equal(youtubeId(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')), 'dQw4w9WgXcQ');
  assert.equal(youtubeId(new URL('https://youtu.be/dQw4w9WgXcQ?si=x')), 'dQw4w9WgXcQ');
  assert.equal(youtubeId(new URL('https://www.youtube.com/shorts/abcDEF12345')), 'abcDEF12345');
  assert.equal(youtubeId(new URL('https://www.youtube.com/@channel')), undefined);
});
test('parseYouTubePlayer reads public description and keywords', () => {
  const html = '..."lengthSeconds":"213","keywords":["a","b c"],"shortDescription":"Line one\\nLine \\"two\\"","author":"Chan"...';
  const r = parseYouTubePlayer(html);
  assert.equal(r.description, 'Line one\nLine "two"'); assert.deepEqual(r.keywords, ['a', 'b c']); assert.equal(r.durationSeconds, 213); assert.equal(r.author, 'Chan');
});
test('normalizeAnalysis tolerates missing optional fields and rejects empty summary', () => {
  const a = normalizeAnalysis({ summary: 'Overview\n\n🎬 Scene: tiny cars', tags: ['x'] }, { title: 'T', platform: 'YouTube', level: 'metadata' });
  assert.equal(a.title, 'T'); assert.ok(a.key_takeaways.length >= 1); assert.equal(a.confidence, 0.5);
  assert.throws(() => normalizeAnalysis({ summary: '  ' }, { title: 'T', platform: 'YouTube', level: 'metadata' }));
});
