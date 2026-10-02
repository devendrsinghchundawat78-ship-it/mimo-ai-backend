import type { AIProvider, AIRequest, AIResult, ProviderName } from '../types.js';
import type { Config } from '../../config.js';
import { ProviderError, networkFailure, providerFailure } from '../providerError.js';
export class GeminiProvider implements AIProvider {
 constructor(public name: ProviderName, private key: string, private config: Pick<Config,'GEMINI_TEXT_MODEL'|'GEMINI_JSON_MODEL'>) {}
 modelFor(r: AIRequest): string { return r.json ? this.config.GEMINI_JSON_MODEL : this.config.GEMINI_TEXT_MODEL; }
 async generate(r: AIRequest, signal: AbortSignal): Promise<AIResult> {
  const model = this.modelFor(r);
  // Gemini 2.5 Flash models spend output tokens on hidden "thinking"; with a small cap this truncates JSON. Disable thinking for them.
  const thinking = /2\.5-flash/.test(model) ? {thinkingConfig:{thinkingBudget:0}} : {};
  let response: Response;
  try {
   response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method:'POST', signal, headers:{'Content-Type':'application/json','x-goog-api-key':this.key},
    body:JSON.stringify({systemInstruction:{parts:[{text:r.system}]},contents:r.messages.map(m => ({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:4096,...thinking,...(r.json ? {responseMimeType:'application/json'} : {})}})
   });
  } catch (error) { throw networkFailure(this.name,model,error); }
  if (!response.ok) throw await providerFailure(this.name,model,response);
  const body = await response.json() as { candidates?: { finishReason?: string; content?: { parts?: {text?:string}[] } }[]; promptFeedback?: { blockReason?: string }; usageMetadata?: { promptTokenCount?:number; candidatesTokenCount?:number } };
  const text = body.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new ProviderError(this.name,model,response.status,'EMPTY_RESULT','finishReason=' + (body.candidates?.[0]?.finishReason ?? body.promptFeedback?.blockReason ?? 'none'));
  return {text,provider:this.name,model,inputTokens:body.usageMetadata?.promptTokenCount ?? 0,outputTokens:body.usageMetadata?.candidatesTokenCount ?? 0};
 }
}
export function gemini1(c: Config): AIProvider | undefined { return c.GEMINI_API_KEY_1 ? new GeminiProvider('gemini1', c.GEMINI_API_KEY_1,c) : undefined; }
