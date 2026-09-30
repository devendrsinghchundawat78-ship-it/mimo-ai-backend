import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIRouter } from '../src/ai/router.js';
import type { AIRequest, AIResult, AIProvider } from '../src/ai/types.js';
const request:AIRequest={userId:'test-user',capability:'chat',messages:[{role:'user',content:'hello'}],system:'Mimo AI',json:false};
const result:AIResult={text:'hello',provider:'groq',model:'test-model',inputTokens:1,outputTokens:1};
test('fallback order and duplicate inflight coalescing',async()=>{
 const calls:string[]=[];
 const providers:AIProvider[]=[{name:'gemini1',async generate(){calls.push('gemini1');throw new Error('rate limited');}},{name:'gemini2',async generate(){calls.push('gemini2');throw new Error('unavailable');}},{name:'groq',async generate(){calls.push('groq');return result;}}];
 const router=new AIRouter(providers);
 const a=router.run(request),b=router.run(request);assert.equal(a,b);assert.deepEqual(await a,result);assert.deepEqual(calls,['gemini1','gemini2','groq']);
});
test('isolates users for dedupe',async()=>{
 let calls=0;const router=new AIRouter([{name:'groq',async generate(){calls++;return result;}}]);
 await Promise.all([router.run(request),router.run({...request,userId:'other-user'})]);assert.equal(calls,2);
});
test('timeout aborts stalled provider and falls back',async()=>{
 let signal:AbortSignal|undefined;
 const router=new AIRouter([{name:'gemini1',generate(_r,s){signal=s;return new Promise(()=>{});}},{name:'groq',async generate(){return result;}}],10);
 assert.equal((await router.run(request)).provider,'groq');assert.equal(signal?.aborted,true);
});
test('invalid JSON triggers fallback',async()=>{
 const router=new AIRouter([{name:'gemini1',async generate(){return {...result,text:'not JSON'};}},{name:'groq',async generate(){return {...result,text:'{"tags":[]}'};}}]);
 assert.equal((await router.run({...request,json:true})).text,'{"tags":[]}');
});
test('all failed produces safe unavailable error',async()=>{
 await assert.rejects(new AIRouter([]).run(request),/temporarily unavailable/);
});
test('backpressure rejects nonduplicate requests',async()=>{
 const router=new AIRouter([{name:'groq',generate(){return new Promise(()=>{});}}],10,1);
 const pending=router.run(request);await assert.rejects(router.run({...request,userId:'another-user'}),/busy/);await assert.rejects(pending);
});
