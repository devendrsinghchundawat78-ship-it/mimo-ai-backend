import type { SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import type { ProcessingJob } from '../ai/types.js';
import type { SaveProcessor } from './saveProcessor.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
export class AIJobs {
 private stopping=false; private loop?:Promise<void>; private wake?:()=>void;
 constructor(private db:SupabaseClient,private processor:SaveProcessor,private config:Config) {}
 async enqueue(userId:string,saveId:string):Promise<ProcessingJob> {
  await this.processor.ownedSave(userId,saveId);
  const {data,error}=await this.db.rpc('mimo_ai_job_enqueue',{p_user_id:userId,p_save_id:saveId});
  if (error || !data) throw new AppError(503,'JOB_ENQUEUE_FAILED','Processing job could not be created');return data as ProcessingJob;
 }
 async get(userId:string,id:string):Promise<ProcessingJob> {
  const {data,error}=await this.db.from('ai_processing_jobs').select('id,user_id,save_id,status,attempts,updated_at,result,error_code').eq('id',id).eq('user_id',userId).maybeSingle();
  if (error) throw new AppError(503,'JOB_READ_FAILED','Job unavailable');
  if (!data) throw new AppError(404,'JOB_NOT_FOUND','Job not found');return data as ProcessingJob;
 }
 start(): void {if(!this.loop) this.loop=this.work();}
 async stop():Promise<void> {this.stopping=true;this.wake?.();await this.loop;}
 private async work():Promise<void> {
  while(!this.stopping) {
   try {
    const {data,error}=await this.db.rpc('mimo_ai_job_claim',{p_lease_ms:this.config.JOB_LEASE_MS,p_max_attempts:this.config.JOB_MAX_ATTEMPTS});
    if (error) throw new Error('Job claim failed');
    const job=data as (ProcessingJob & {lease_token:string}) | null;
    if(job) {
     try {
      const result=await this.processor.process(job.user_id,job.save_id);
      const {error:finishError}=await this.db.rpc('mimo_ai_job_finish',{p_job_id:job.id,p_lease_token:job.lease_token,p_result:result,p_error_code:null,p_max_attempts:this.config.JOB_MAX_ATTEMPTS});
      if(finishError) throw new Error('Job completion failed');
     } catch(error) {
      const code=error instanceof AppError ? error.code : 'PROCESSING_FAILED';
      const {error:failError}=await this.db.rpc('mimo_ai_job_finish',{p_job_id:job.id,p_lease_token:job.lease_token,p_result:null,p_error_code:code,p_max_attempts:this.config.JOB_MAX_ATTEMPTS});
      if(failError) logger.error({event:'job_status_write_failed',jobId:job.id});
     }
     continue;
    }
   } catch {logger.error({event:'job_poll_failed'});}
   await new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.wake=undefined;resolve();},this.config.JOB_POLL_MS);this.wake=()=>{clearTimeout(timer);this.wake=undefined;resolve();};});
  }
 }
}
