# Mimo AI backend

Private TypeScript / Express 5 service. Railway runs Mimo AI routing and durable save-processing workers; the existing Supabase project remains responsible for users, auth, saves, conversations, messages, usage, processing jobs and storage. No Android UI changes are included.

## Readiness and scope

`npm ci`, `npm run build` and `npm test` validate the code without secrets. This is deployable source, not a claim that a live Railway deployment or the existing database has been tested. The existing table column shapes were not verified. Review the schema contract below before production use. No Supabase settings, tables or other repos were modified to build this service.

## Files

```text
src/
  server.ts
  config.ts
  auth/supabaseAuth.ts
  ai/router.ts
  ai/types.ts
  ai/providers/gemini1.ts
  ai/providers/gemini2.ts
  ai/providers/groq.ts
  routes/chat.ts
  routes/processSave.ts
  routes/health.ts
  services/aiUsage.ts
  services/aiJobs.ts
  services/saveProcessor.ts
  utils/errors.ts
  utils/logger.ts
supabase/schema-contract.sql
tests/router.test.ts
tests/security.test.ts
package.json
package-lock.json
tsconfig.json
Dockerfile
railway.json
.dockerignore
.gitignore
.env.example
README.md
```

## Railway deployment

1. In Railway, create a project from this private GitHub repository. Give Railway access only to this repo. Railway selects the Dockerfile and health check from `railway.json`.
2. Add secrets as Railway Variables, never source files. Required: `SUPABASE_URL` (use your existing Mimo project URL), `SUPABASE_SERVICE_ROLE_KEY`, and at least one of `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, `GROQ_API_KEY`. Configure all three to enable the full Gemini #1 -> Gemini #2 -> Groq chain.
3. Review database assumptions and RPCs below against your current migration. Deploying this repo does not run SQL automatically. An owner or administrator must reconcile differences first.
4. Verify provider model access and set the model names in Railway if needed. Defaults: `gemini-2.5-flash` and `llama-3.3-70b-versatile`. These are configurable and model availability changes; startup does not prove provider access.
5. Deploy, generate Railway's HTTPS domain, call `GET /health`, then test each authenticated endpoint and an end-to-end process-save job using your own test account.
6. Point the Android client to this domain and send its Supabase access JWT in `Authorization: Bearer <access-token>`. Never embed provider keys or the service-role key in the client.

Railway and provider billing/quota settings are the owner's responsibility. This repo does not enable paid services or provision accounts. Two Gemini keys may share a project quota; a second key is not guaranteed extra capacity. Workers use durable DB leases and can run on multiple replicas after the SQL contract is installed. Per-minute HTTP throttling is per replica; daily AI quota and in-flight fingerprint reservations are database-atomic.

## Environment variable names

`.env.example` contains names only, intentionally not dotenv assignments, credentials or sample values. It is a checklist, not a file to load. Set variables in Railway or your shell securely.

| Name | Purpose / default |
| --- | --- |
| SUPABASE_URL | Required existing HTTPS project URL |
| SUPABASE_SERVICE_ROLE_KEY | Required server-only service-role credential |
| GEMINI_API_KEY_1 | Primary provider credential |
| GEMINI_API_KEY_2 | Secondary provider credential |
| GROQ_API_KEY | Final fallback credential |
| PORT | Railway supplies it; local default 3000 |
| CORS_ORIGINS | Comma-separated allowed web origins; empty denies browser origins, native clients unaffected |
| GEMINI_TEXT_MODEL / GEMINI_JSON_MODEL | Text/chat and structured-output model selection |
| GROQ_TEXT_MODEL / GROQ_JSON_MODEL | Text/chat and structured-output model selection |
| AI_TIMEOUT_MS | Per-provider timeout, default 20000; full chain can take about 60 seconds |
| AI_DAILY_REQUEST_LIMIT | Per user UTC-day reservations, default 100; failed attempts count too |
| AI_MAX_CONCURRENT | Per-process generation concurrency, default 8 |
| JOB_POLL_MS | Worker cadence, default 5000 |
| JOB_LEASE_MS | Worker lease, default 300000; must exceed content fetch + provider chain + DB writes |
| JOB_MAX_ATTEMPTS | Retry limit, default 3 |
| ENABLE_JOB_WORKER | true by default; false makes an API-only instance |
| TRUST_PROXY_HOPS | Default 0; set to actual trusted proxy hop count, never blindly trust forwarded headers |

## HTTP API

All `/ai/*` routes require a JWT verified online with Supabase `auth.getUser()`. Client user IDs are never trusted. Bodies must be JSON and at most 128 KiB. Errors use `{error:{code,message},requestId}` without upstream bodies, keys or provider identity. AI replies identify as Mimo AI. Provider names and token counts stay in server-side usage records.

| Method / route | Body | Success |
| --- | --- | --- |
| GET /health | none, public | 200 `{status:"ok",service:"mimo-ai-backend"}` (liveness, not DB/provider readiness) |
| POST /ai/chat | `{messages:[{role:"user",content:"..."}], conversationId?: UUID}` | 200 `{name:"Mimo AI",reply:string}` |
| POST /ai/process-save | `{saveId: UUID}` | 202 `{jobId,status,statusPath}` |
| GET /ai/jobs/:id | none | 200 owner-scoped job status/result |
| POST /ai/summarize | `{text:string}` | 200 `{name:"Mimo AI",result:string}` |
| POST /ai/extract | `{text:string}` | 200 result object with facts and entities |
| POST /ai/classify | `{text:string}` | 200 result object with category and reason |
| POST /ai/generate-tags | `{text:string}` | 200 result object with tags |
| POST /ai/search | `{query:string,limit?:number}` | 200 `{results:[owned saves]}` |

Search uses Supabase full-text retrieval of the caller's saves, not external web search or invented results. Chat accepts up to 20 turns / 32000 characters; text tasks accept 24000 characters. `conversationId` is optional: when supplied it must already exist and belong to the caller, and the last input plus assistant reply are persisted. Conversation creation and loading older history remain with the app / Supabase.

## Save processing

The client saves the item to Supabase first, then submits its `saveId`. The server verifies ownership, deduplicates active jobs in Supabase, claims a job with `FOR UPDATE SKIP LOCKED`, fetches bounded public HTML, processes metadata/text, validates `{summary,category,tags,usefulInfo}`, and writes `saves.ai_result`. Job status survives process restarts. Failed jobs retry with bounded backoff; expired leases are reclaimed. The queue is at-least-once: a crash between provider completion and job completion can repeat provider work, so retain conservative provider quotas.

YouTube/public links are treated as metadata sources only. There is no video download, DRM bypass, transcript scraping or claim to summarize unseen video content. A login wall, blocked page, oversized response or non-HTML link results in a reported processing error. Caller-supplied link credentials, HTTP, private/local DNS answers and nonstandard ports are blocked. Every redirect is revalidated and the validated DNS address is pinned for TLS requests. There is no JS execution in fetched pages. Source text is explicitly untrusted; AI has no tools or ability to run commands.

## Supabase contract (must review)

The backend uses existing `public.ai_usage` and `public.ai_processing_jobs` names. `supabase/schema-contract.sql` is an unapplied reference contract with atomic service-role-only RPCs, indexes and RLS. `CREATE TABLE IF NOT EXISTS` does not repair an incompatible existing table. Compare current column definitions and migration history first; do not blindly apply it over a different schema.

Required existing saves shape: `public.saves(id uuid, user_id uuid, url text nullable, title text nullable, content text nullable, ai_result jsonb nullable)`. Search also needs `search_vector tsvector`, generated/indexed from the desired searchable fields by your existing migration. This contract does not alter saves. If your app uses `saved_items`, different ownership columns, or a separate AI results table, adapt the server queries to the verified schema before deployment.

Optional conversation persistence expects `public.ai_conversations(id uuid,user_id uuid)` and `public.ai_messages(conversation_id uuid,user_id uuid,role text,content text)` plus your own message IDs/default timestamps. The owner filter is checked before using the service role. Existing Auth, storage, RLS and app migrations remain unchanged.

`ai_usage` expects `id,user_id,fingerprint,status,provider,model,input_tokens,output_tokens,created_at,finished_at`. `ai_processing_jobs` expects `id,user_id,save_id,status,attempts,result,error_code,lease_token,lease_until,available_at,created_at,updated_at`. The SQL file defines exact types and the four RPCs:

- `mimo_ai_usage_reserve`: atomic per-user daily reservation and duplicate-pending guard.
- `mimo_ai_job_enqueue`: idempotent active save-job creation.
- `mimo_ai_job_claim`: atomic claim, retry limit, expired lease recovery.
- `mimo_ai_job_finish`: lease-token-protected completion or retry.

Public/anon/authenticated cannot call these RPCs or access these two tables; only the server's service role can. Run the service only against the intended project and protect Railway access. Usage does not retain prompts or generated text. Jobs and saves do retain generated results; apply your existing retention/deletion rules to them.

## Local verification

```sh
npm ci
npm run build
npm test
```

To start locally, provide real secrets via the environment (not committed files) and run `npm start`. Unit tests need no API keys and mock provider responses, not credentials. For production acceptance, test JWT expiry, cross-user access, provider 429/timeout fallback, DB RPC quotas, worker restart/retry, metadata fetch failures and actual schema compatibility. Unit tests do not replace these live checks.

## Upstream references

- Gemini REST generation: https://ai.google.dev/api/generate-content
- Gemini models: https://ai.google.dev/gemini-api/docs/models
- Groq model catalog: https://console.groq.com/docs/models
- Groq OpenAI compatibility: https://console.groq.com/docs/openai
