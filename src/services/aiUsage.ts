import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AIRequest, AIResult } from '../ai/types.js';
import { AppError } from '../utils/errors.js';
export class AIUsage {
 constructor(private db: SupabaseClient, private dailyLimit: number) {}
 async run(r: AIRequest, action: () => Promise<AIResult>): Promise<AIResult> {
  // Database RPC is atomic: idempotency and daily quotas must span Railway replicas.
  const fingerprint = createHash('sha256').update(JSON.stringify(r)).digest('hex');
  const {data:id,error} = await this.db.rpc('mimo_ai_usage_reserve',{p_user_id:r.userId,p_fingerprint:fingerprint,p_daily_limit:this.dailyLimit});
  if (error || typeof id !== 'string') throw new AppError(429,'AI_QUOTA_OR_BUSY','AI quota reached or duplicate request still running');
  try {
   const result = await action();
   const {error:updateError} = await this.db.from('ai_usage').update({status:'completed',provider:result.provider,model:result.model,input_tokens:result.inputTokens,output_tokens:result.outputTokens,finished_at:new Date().toISOString()}).eq('id',id).eq('user_id',r.userId);
   if (updateError) throw new AppError(503,'USAGE_WRITE_FAILED','AI usage could not be recorded');
   return result;
  } catch (error) {
   await this.db.from('ai_usage').update({status:'failed',finished_at:new Date().toISOString()}).eq('id',id).eq('user_id',r.userId);
   throw error;
  }
 }
}
