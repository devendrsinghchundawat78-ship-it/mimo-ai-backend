import type { AIProvider, AIRequest, AIResult, ProviderName } from '../types.js';
import type { Config } from '../../config.js';
import { ProviderError, networkFailure, providerFailure } from '../providerError.js';
type GeminiConfig = Pick<Config,'GEMINI_TEXT_MODEL'|'GEMINI_JSON_MODEL'> & { GEMINI_FALLBACK_MODELS?: string };
export class GeminiProvider implements AIProvider {
 private working = new Map<string,string>();
 supportsVideo = true;
 constructor(public name: ProviderName, private key: string, private config: GeminiConfig) {}
 modelFor(r: AIRequest): string { return this.working.get(this.primary(r)) ?? this.primary(r); }
 private primary(r: AIRequest): string { return r.json ? this.config.GEMINI_JSON_MODEL : this.config.GEMINI_TEXT_MODEL; }
 // Safe diagnostic: names of models this key can use for generateContent (no secrets).
 async listModels(signal: AbortSignal): Promise<string[]> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',{signal,headers:{'x-goog-api-key':this.key}});
  if (!response.ok) throw await providerFailure(this.name,'list-models',response);
  const body = await response.json() as {models?:{name?:string;supportedGenerationMethods?:string[]}[]};
  return (body.models ?? []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => (m.name ?? '').replace(/^models\//,'')).filter(Boolean);
 }
 async generate(r: AIRequest, signal: AbortSignal): Promise<AIResult> {
  const primary = this.primary(r);
  const chain = [this.working.get(primary) ?? primary, primary, ...(this.config.GEMINI_FALLBACK_MODELS ?? '').split(',').map(m => m.trim()).filter(Boolean)].filter((m,i,a) => a.indexOf(m) === i);
  let last: unknown;
  for (const model of chain) {
   try { const result = await this.call(r,signal,model); this.working.set(primary,model); return result; }
   catch (error) {
    last = error;
    // Only walk the model chain when the model itself is unavailable; other failures go to the next provider.
    if (!(error instanceof ProviderError) || error.upstreamStatus !== 404) throw error;
   }
  }
  throw last;
 }
 private async call(r: AIRequest, signal: AbortSignal, model: string, withThinking = true): Promise<AIResult> {
  // Flash models spend output tokens on hidden "thinking"; with a small cap this truncates JSON. Disable thinking where supported.
  const thinking = withThinking && /flash/.test(model) && !/lite/.test(model) ? {thinkingConfig:{thinkingBudget:0}} : {};
  let response: Response;
  try {
   response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method:'POST', signal, headers:{'Content-Type':'application/json','x-goog-api-key':this.key},
    body:JSON.stringify({systemInstruction:{parts:[{text:r.system}]},contents:r.messages.map((m,i,all) => ({role:m.role==='assistant'?'model':'user',parts:[...(r.videoUrl && i===all.length-1 && m.role==='user' ? [{fileData:{fileUri:r.videoUrl}}] : []),{text:m.content}]})),generationConfig:{maxOutputTokens:4096,...thinking,...(r.json ? {responseMimeType:'application/json'} : {})}})
   });
  } catch (error) { throw networkFailure(this.name,model,error); }
  if (!response.ok) {
   const failure = await providerFailure(this.name,model,response);
   if (failure.upstreamStatus === 400 && withThinking && Object.keys(thinking).length) return this.call(r,signal,model,false);
   throw failure;
  }
  const body = await response.json() as { candidates?: { finishReason?: string; content?: { parts?: {text?:string}[] } }[]; promptFeedback?: { blockReason?: string }; usageMetadata?: { promptTokenCount?:number; candidatesTokenCount?:number } };
  const text = body.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
  if (!text.trim()) throw new ProviderError(this.name,model,response.status,'EMPTY_RESULT','finishReason=' + (body.candidates?.[0]?.finishReason ?? body.promptFeedback?.blockReason ?? 'none'));
  return {text,provider:this.name,model,inputTokens:body.usageMetadata?.promptTokenCount ?? 0,outputTokens:body.usageMetadata?.candidatesTokenCount ?? 0};
 }
}
export function gemini1(c: Config): AIProvider | undefined { return c.GEMINI_API_KEY_1 ? new GeminiProvider('gemini1', c.GEMINI_API_KEY_1,c) : undefined; }
