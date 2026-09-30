import { createHash } from 'node:crypto';
import type { AIProvider, AIRequest, AIResult } from './types.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
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
 private async execute(request: AIRequest): Promise<AIResult> {
  for (const p of this.providers) {
   const controller = new AbortController();
   let timer: NodeJS.Timeout | undefined;
   try {
    const timeout = new Promise<never>((_,reject) => {timer=setTimeout(() => {controller.abort();reject(new AppError(504,'AI_TIMEOUT','AI request timed out'));},this.timeoutMs);});
    const result = await Promise.race([p.generate(request,controller.signal),timeout]);
    if (request.json) { try { JSON.parse(result.text); } catch { throw new AppError(502,'INVALID_AI_JSON','AI returned invalid JSON'); } }
    return result;
   } catch { logger.warn({provider:p.name,event:'provider_fallback'}); }
   finally { clearTimeout(timer); }
  }
  throw new AppError(503,'AI_UNAVAILABLE','Mimo AI is temporarily unavailable');
 }
}
