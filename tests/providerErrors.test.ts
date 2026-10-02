import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, providerFailure } from '../src/ai/providerError.js';
import { GeminiProvider } from '../src/ai/providers/gemini1.js';
import { groq } from '../src/ai/providers/groq.js';
import { loadConfig } from '../src/config.js';
import type { AIRequest } from '../src/ai/types.js';
const req:AIRequest={userId:'u',capability:'process-save',json:true,system:'s',messages:[{role:'user',content:'x'}]};
const base={SUPABASE_URL:'https://x.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'k',GROQ_API_KEY:'gsk_abcdefghijklmnop'};
test('redact strips keys, bearer tokens and JWTs',()=>{
 const out=redact('bad AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA Bearer abc.def eyJhbGci.eyJzdWIi.sig url?key=SECRET123');
 assert.doesNotMatch(out,/AIza|abc\.def|eyJ|SECRET123/);
});
test('providerFailure parses Gemini error body safely',async()=>{
 const e=await providerFailure('gemini1','m',new Response(JSON.stringify({error:{code:404,status:'NOT_FOUND',message:'model not found AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}}),{status:404}));
 assert.equal(e.upstreamStatus,404);assert.equal(e.upstreamCode,'NOT_FOUND');assert.doesNotMatch(e.safeMessage,/AIza/);
});
test('Groq defaults to gpt-oss-120b and falls back on model error',async()=>{
 const c=loadConfig({...base} as NodeJS.ProcessEnv);assert.equal(c.GROQ_TEXT_MODEL,'openai/gpt-oss-120b');
 const models:string[]=[];const orig=globalThis.fetch;
 globalThis.fetch=(async(_u:unknown,init:RequestInit)=>{const m=JSON.parse(String(init.body)).model as string;models.push(m);
  return m.startsWith('openai/')?new Response(JSON.stringify({error:{message:'model_not_found',type:'invalid_request_error',code:'model_not_found'}}),{status:404}):new Response(JSON.stringify({choices:[{message:{content:'{"a":1}'}}]}),{status:200});}) as typeof fetch;
 try{const r=await groq(c)!.generate(req,new AbortController().signal);assert.equal(r.model,'llama-3.3-70b-versatile');assert.deepEqual(models,['openai/gpt-oss-120b','llama-3.3-70b-versatile']);}finally{globalThis.fetch=orig;}
});
test('Gemini failure carries status and model, request never contains key in body',async()=>{
 const orig=globalThis.fetch;let body='';
 globalThis.fetch=(async(_u:unknown,init:RequestInit)=>{body=String(init.body);return new Response(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'quota'}}),{status:429});}) as typeof fetch;
 try{await assert.rejects(new GeminiProvider('gemini1','SECRETKEY',{GEMINI_TEXT_MODEL:'gemini-2.5-flash',GEMINI_JSON_MODEL:'gemini-2.5-flash'}).generate(req,new AbortController().signal),(e:any)=>e.upstreamStatus===429&&e.upstreamCode==='RESOURCE_EXHAUSTED'&&e.model==='gemini-2.5-flash');assert.doesNotMatch(body,/SECRETKEY/);}finally{globalThis.fetch=orig;}
});
test('Gemini walks fallback models only on 404 and remembers the working one',async()=>{
 const orig=globalThis.fetch;const seen:string[]=[];
 globalThis.fetch=(async(u:string)=>{const m=/models\/([^:]+):/.exec(String(u))![1]!;seen.push(m);return m==='old'?new Response(JSON.stringify({error:{code:404,status:'NOT_FOUND',message:'gone'}}),{status:404}):new Response(JSON.stringify({candidates:[{content:{parts:[{text:'{"a":1}'}]}}]}),{status:200});}) as unknown as typeof fetch;
 try{const g=new GeminiProvider('gemini1','K',{GEMINI_TEXT_MODEL:'old',GEMINI_JSON_MODEL:'old',GEMINI_FALLBACK_MODELS:'new'});
  assert.equal((await g.generate(req,new AbortController().signal)).model,'new');await g.generate(req,new AbortController().signal);assert.deepEqual(seen,['old','new','new']);}finally{globalThis.fetch=orig;}
});
