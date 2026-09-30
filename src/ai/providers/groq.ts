import type { Config } from '../../config.js';
import type { AIProvider, AIResult } from '../types.js';
import { AppError } from '../../utils/errors.js';
export function groq(c: Config): AIProvider | undefined {
 if (!c.GROQ_API_KEY) return undefined;
 return {name:'groq',async generate(r,signal): Promise<AIResult> {
  const model = r.json ? c.GROQ_JSON_MODEL : c.GROQ_TEXT_MODEL;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.GROQ_API_KEY}`},body:JSON.stringify({model,messages:[{role:'system',content:r.system},...r.messages],max_tokens:2048,...(r.json ? {response_format:{type:'json_object'}} : {})})});
  if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status===429 ? 429 : 502,'PROVIDER_ERROR','AI provider unavailable'); }
  const body = await response.json() as {choices?:{message?:{content?:string}}[];usage?:{prompt_tokens?:number;completion_tokens?:number}};
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new AppError(502,'EMPTY_AI_RESULT','AI did not return content');
  return {text,provider:'groq',model,inputTokens:body.usage?.prompt_tokens??0,outputTokens:body.usage?.completion_tokens??0};
 }};
}
