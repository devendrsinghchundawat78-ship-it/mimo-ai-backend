import { Router } from 'express';
export function healthRoutes():Router {
 const routes=Router();routes.get('/health',(_req,res)=>res.json({status:'ok',service:'mimo-ai-backend'}));return routes;
}
