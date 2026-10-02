import { createHash } from 'node:crypto';
import type { AIProvider, AIRequest, AIResult } from './types.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { ProviderError, redact } from './providerError.js';
export class AIRouter {
 private inflight = new Map<string, Promise<AIResult>>();
 private active = 0;
 constructor(private providers: AIProvider[], private timeoutMs = 20000, private maxConcurrent = 8) {}
 run(request: AIRequest): Promise<AIResult> {
  const key = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const duplicate = this.inflight.get(key); if (duplicate) return duplicate;
  if (this.active >= this.maxConcurrent) return Promise.reject(new AppError(503,'AI_BUSY','Mimo AI is busy, retry shortly'));
  this.active++;
  const pending = this.execute(request).finally(() => { this.inflight.delete(key); this.active--; });
  this.inflight.set(key,pending); return pending;
 }
 // Safe diagnostic: one tiny request per provider, logged without any secret. Does not touch user data or quotas.
 async selfCheck(): Promise<void> {
  const request: AIRequest = {userId:'selfcheck',capability:'classify',json:true,system:'Reply with JSON only.',messages:[{role:'user',content:'Return {"ok":true}'}]};
  for (const p of this.providers) {
   const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),this.timeoutMs);
   try {
    const lister = (p as { listModels?: (s: AbortSignal) => Promise<string[]> }).listModels;
    if (lister) { try { const names = await lister.call(p,controller.signal); logger.info({event:'provider_models',provider:p.name,count:names.length,models:names.filter(n => /gemini/.test(n)).slice(0,40)}); } catch (error) { this.logFailure(p,request,error); } }
    const r = await p.generate(request,controller.signal); logger.info({event:'provider_selfcheck',provider:p.name,model:r.model,ok:true}); }
   catch (error) { this.logFailure(p,request,error); }
   finally { clearTimeout(timer); }
  }
 }
 // Safe diagnostic for public-video understanding: one tiny request on a 19s public YouTube video, logged without any secret.
 async videoSelfCheck(): Promise<void> {
  const request: AIRequest = {userId:'selfcheck',capability:'classify',json:true,timeoutMs:45000,videoUrl:'https://www.youtube.com/watch?v=jNQXAC9IVRw',system:'Reply with JSON only.',messages:[{role:'user',content:'Return {"shows": "one short sentence describing what is shown and said in the attached video"}'}]};
  for (const p of this.providers) {
   if (!p.supportsVideo) continue;
   const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),45000);
   try { const r = await p.generate(request,controller.signal); logger.info({event:'video_selfcheck',provider:p.name,model:r.model,ok:true,answer:r.text.slice(0,300)}); return; }
   catch (error) { this.logFailure(p,request,error); }
   finally { clearTimeout(timer); }
  }
 }
 private logFailure(p: AIProvider, request: AIRequest, error: unknown): void {
  const pe = error instanceof ProviderError ? error : undefined;
  const app = error instanceof AppError ? error : undefined;
  logger.warn({event:'provider_failed',provider:p.name,model:pe?.model ?? p.modelFor?.(request),httpStatus:pe?.upstreamStatus ?? app?.status,errorCode:pe?.upstreamCode ?? app?.code ?? 'UNKNOWN',errorMessage:redact(pe?.safeMessage ?? app?.message ?? (error as Error)?.message ?? ''),capability:request.capability});
 }
 private async execute(request: AIRequest): Promise<AIResult> {
  let failures = 0;
  for (const p of this.providers) {
   if (request.videoUrl && !p.supportsVideo) continue;
   const controller = new AbortController();
   let timer: NodeJS.Timeout | undefined;
   try {
    const timeout = new Promise<never>((_,reject) => {timer=setTimeout(() => {controller.abort();reject(new AppError(504,'AI_TIMEOUT','AI request timed out'));},request.timeoutMs ?? this.timeoutMs);});
    const result = await Promise.race([p.generate(request,controller.signal),timeout]);
    if (request.json) { try { JSON.parse(result.text); } catch { throw new AppError(502,'INVALID_AI_JSON','AI returned invalid JSON'); } }
    return result;
   } catch (error) { failures++; this.logFailure(p,request,error); logger.warn({provider:p.name,event:'provider_fallback'}); }
   finally { clearTimeout(timer); }
  }
  logger.error({event:'all_providers_failed',providers:this.providers.length,failures});
  throw new AppError(503,'AI_UNAVAILABLE','Mimo AI is temporarily unavailable');
 }
}
