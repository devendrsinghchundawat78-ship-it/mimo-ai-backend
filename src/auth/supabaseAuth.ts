import type { RequestHandler } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../utils/errors.js';

export function supabaseAuth(db: SupabaseClient): RequestHandler {
 return async (req, res, next) => {
  const match = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match || match[1]!.length > 8192) return next(new AppError(401, 'UNAUTHORIZED', 'Valid login required'));
  try {
   const { data, error } = await db.auth.getUser(match[1]!);
   if (error || !data.user) return next(new AppError(401, 'UNAUTHORIZED', 'Valid login required'));
   res.locals.userId = data.user.id;
   res.locals.userJwt = match[1]!;
   next();
  } catch {
   next(new AppError(503, 'AUTH_UNAVAILABLE', 'Login verification unavailable'));
  }
 };
}
