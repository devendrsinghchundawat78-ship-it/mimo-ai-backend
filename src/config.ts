import { z } from 'zod';
const bool = z.enum(['true','false']).default('true').transform(v => v === 'true');
const schema = z.object({
 NODE_ENV: z.enum(['development','test','production']).default('development'),
 PORT: z.coerce.number().int().min(1).max(65535).default(3000),
 SUPABASE_URL: z.url().refine(v => v.startsWith('https://')),
 SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
 SUPABASE_LINK_DETAILS_URL: z.url().default('https://ugomjglbzcjekibnupin.supabase.co/functions/v1/mimo-link-details'),
 SUPABASE_AI_RECOVERY_URL: z.url().default('https://ugomjglbzcjekibnupin.supabase.co/functions/v1/mimo-link-ai-recovery'),
 GEMINI_API_KEY_1: z.string().optional(), GEMINI_API_KEY_2: z.string().optional(), GROQ_API_KEY: z.string().optional(),
 GEMINI_TEXT_MODEL: z.string().default('gemini-2.5-flash'), GEMINI_JSON_MODEL: z.string().default('gemini-2.5-flash'),
 GROQ_TEXT_MODEL: z.string().default('openai/gpt-oss-120b'), GROQ_JSON_MODEL: z.string().default('openai/gpt-oss-120b'), GROQ_FALLBACK_MODEL: z.string().default('llama-3.3-70b-versatile'),
 CORS_ORIGINS: z.string().default(''), TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
 AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
 AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).default(100),
 AI_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(8),
 JOB_POLL_MS: z.coerce.number().int().min(1000).default(5000),
 JOB_LEASE_MS: z.coerce.number().int().min(120000).default(300000),
 JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3), ENABLE_JOB_WORKER: bool, AI_STARTUP_SELFCHECK: bool
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
 const parsed = schema.safeParse(env);
 if (!parsed.success) throw new Error('Invalid environment variable names: ' + parsed.error.issues.map(i => i.path.join('.')).join(', '));
 const c = parsed.data;
 if (![c.GEMINI_API_KEY_1,c.GEMINI_API_KEY_2,c.GROQ_API_KEY].some(Boolean)) throw new Error('Configure at least one AI provider in Railway variables');
 return c;
}
