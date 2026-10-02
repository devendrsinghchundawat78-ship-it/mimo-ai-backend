import type { Config } from '../../config.js';
import type { AIProvider, AIRequest, AIResult } from '../types.js';
import { ProviderError, networkFailure, providerFailure } from '../providerError.js';
export function groq(c: Config): AIProvider | undefined {
 if (!c.GROQ_API_KEY) return undefined;
 const pick = (r: AIRequest) => r.json ? c.GROQ_JSON_MODEL : c.GROQ_TEXT_MODEL;
 async function call(r: AIRequest, signal: AbortSignal, model: string): Promise<AIResult> {
  // gpt-oss models are reasoning models: keep reasoning short so it does not consume the output budget.
  const reasoning = model.startsWith('openai/gpt-oss') ? {reasoning_effort:'low'} : {};
  let response: Response;
  try {
   response = await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.GROQ_API_KEY}`},body:JSON.stringify({model,messages:[{role:'system',content:r.system},...r.messages],max_completion_tokens:4096,...reasoning,...(r.json ? {response_format:{type:'json_object'}} : {})})});
  } catch (error) { throw networkFailure('groq',model,error); }
  if (!response.ok) throw await providerFailure('groq',model,response);
  const body = await response.json() as {choices?:{finish_reason?:string;message?:{content?:string}}[];usage?:{prompt_tokens?:number;completion_tokens?:number}};
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new ProviderError('groq',model,response.status,'EMPTY_RESULT','finish_reason=' + (body.choices?.[0]?.finish_reason ?? 'none'));
  return {text,provider:'groq',model,inputTokens:body.usage?.prompt_tokens??0,outputTokens:body.usage?.completion_tokens??0};
 }
 return {name:'groq',modelFor:pick,async generate(r,signal): Promise<AIResult> {
  const model = pick(r);
  try { return await call(r,signal,model); }
  catch (error) {
   // Retire/unavailable model (404/400 model_not_found etc.): try the configured fallback model once.
   const fb = c.GROQ_FALLBACK_MODEL;
   if (error instanceof ProviderError && (error.upstreamStatus === 404 || error.upstreamStatus === 400 || /model/i.test(error.upstreamCode)) && fb && fb !== model) return call(r,signal,fb);
   throw error;
  }
 }};
}
