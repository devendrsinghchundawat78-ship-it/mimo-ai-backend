import type { AIProvider, AIRequest, AIResult, ProviderName } from '../types.js';
import type { Config } from '../../config.js';
import { AppError } from '../../utils/errors.js';
export class GeminiProvider implements AIProvider {
 constructor(public name: ProviderName, private key: string, private config: Pick<Config,'GEMINI_TEXT_MODEL'|'GEMINI_JSON_MODEL'>) {}
 async generate(r: AIRequest, signal: AbortSignal): Promise<AIResult> {
  const model = r.json ? this.config.GEMINI_JSON_MODEL : this.config.GEMINI_TEXT_MODEL;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
   method:'POST', signal, headers:{'Content-Type':'application/json','x-goog-api-key':this.key},
   body:JSON.stringify({systemInstruction:{parts:[{text:r.system}]},contents:r.messages.map(m => ({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:2048,...(r.json ? {responseMimeType:'application/json'} : {})}})
  });
  if (!response.ok) { await response.body?.cancel(); throw new AppError(response.status===429 ? 429 : 502,'PROVIDER_ERROR','AI provider unavailable'); }
  const body = await response.json() as { candidates?: { content?: { parts?: {text?:string}[] } }[]; usageMetadata?: { promptTokenCount?:number; candidatesTokenCount?:number } };
  const text = body.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new AppError(502,'EMPTY_AI_RESULT','AI did not return content');
  return {text,provider:this.name,model,inputTokens:body.usageMetadata?.promptTokenCount ?? 0,outputTokens:body.usageMetadata?.candidatesTokenCount ?? 0};
 }
}
export function gemini1(c: Config): AIProvider | undefined { return c.GEMINI_API_KEY_1 ? new GeminiProvider('gemini1', c.GEMINI_API_KEY_1,c) : undefined; }
