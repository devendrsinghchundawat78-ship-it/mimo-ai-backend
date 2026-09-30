import pino from 'pino';
// Never log input text, JWTs, upstream bodies, URLs, environment variables or credentials.
export const logger = pino({level: process.env.LOG_LEVEL ?? 'info', base: undefined});
