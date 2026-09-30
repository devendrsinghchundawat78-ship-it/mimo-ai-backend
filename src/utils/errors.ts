import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
export class AppError extends Error {
 constructor(public status: number, public code: string, message: string) { super(message); }
}
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
 const invalid = error instanceof ZodError;
 const known = error instanceof AppError;
 const status = invalid ? 400 : known ? error.status : (error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500);
 res.status(status).json({ error: { code: invalid ? 'INVALID_INPUT' : known ? error.code : status === 400 ? 'INVALID_JSON' : status === 413 ? 'BODY_TOO_LARGE' : 'INTERNAL_ERROR', message: invalid ? 'Request validation failed' : known ? error.message : 'Request could not be completed' }, requestId: res.locals.requestId });
};
