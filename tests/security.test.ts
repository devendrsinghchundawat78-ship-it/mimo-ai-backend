import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicAddress,validateURL,extractPage,resultSchema } from '../src/services/saveProcessor.js';
import { loadConfig } from '../src/config.js';
test('blocks private, link local, loopback and mapped IPv4',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1']) assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);
});
test('blocks schemes credentials local hosts and ports',()=>{
 for(const url of ['http://example.com','https://user:password@example.com','https://localhost','https://example.com:8080']) assert.throws(()=>validateURL(url));
 assert.equal(validateURL('https://example.com').protocol,'https:');
});
test('metadata extraction strips scripts',()=>{
 const page=extractPage('<title>Test</title><meta name="description" content="hello"><body><script>bad()</script><main>Article</main></body>');
 assert.equal(page.title,'Test');assert.equal(page.description,'hello');assert.equal(page.text,'Article');
});
test('structured save output is bounded',()=>{
 assert.throws(()=>resultSchema.parse({summary:'s',category:'c',tags:Array(21).fill('tag'),usefulInfo:[]}));
});
test('configuration errors disclose names, not values',()=>{
 assert.throws(()=>loadConfig({SUPABASE_URL:'invalid'}),/Invalid environment variable names/);
});
