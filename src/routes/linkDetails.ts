import { Router } from 'express';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import type { AIRouter } from '../ai/router.js';
import type { AIUsage } from '../services/aiUsage.js';
import { UniversalUrlService } from '../services/urlProcessor.js';
import { AppError } from '../utils/errors.js';

const requestSchema = z.object({
  url: z.string().min(1).max(2048),
  saveId: z.string().uuid().optional()
});

export function linkDetailsRoutes(
  db: SupabaseClient,
  router: AIRouter,
  usage: AIUsage,
  config: Config
): Router {
  const routes = Router();
  const service = new UniversalUrlService(db, router, usage, config);

  routes.post('/link-details', async (req, res, next) => {
    try {
      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, 'INVALID_URL', 'Valid URL is required in request body');
      }

      const userId = res.locals.userId as string;
      const userJwt = res.locals.userJwt as string;

      if (!userId || !userJwt) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authenticated session required');
      }

      const response = await service.processUrl(
        parsed.data.url,
        userId,
        userJwt,
        parsed.data.saveId
      );

      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  return routes;
}
