import { Router } from 'express';
import { z } from 'zod';
import type { AIJobs } from '../services/aiJobs.js';
export function processSaveRoutes(jobs:AIJobs):Router {
 const routes=Router();
 routes.post('/process-save',async(req,res)=>{
  const {saveId}=z.object({saveId:z.uuid()}).parse(req.body);
  const job=await jobs.enqueue(res.locals.userId,saveId,res.locals.userJwt);res.status(202).json({jobId:job.id,status:job.status,statusPath:`/ai/jobs/${job.id}`});
 });
 routes.get('/jobs/:id',async(req,res)=>{const id=z.uuid().parse(req.params.id);res.json(await jobs.get(res.locals.userId,id));});
 return routes;
}
