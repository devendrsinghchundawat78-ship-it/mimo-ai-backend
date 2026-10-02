import { AppError } from '../utils/errors.js';
import type { ProviderName } from './types.js';

// Redact anything that looks like a credential before it can reach logs.
export function redact(text: string): string {
 return text
  .replace(/AIza[0-9A-Za-z_-]{20,}/g,'[redacted-key]')
  .replace(/gsk_[0-9A-Za-z]{10,}/g,'[redacted-key]')
  .replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]')
  .replace(/eyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]*/g,'[redacted-jwt]')
  .replace(/[?&]key=[^&\s"']+/gi,'?key=[redacted]')
  .slice(0,300);
}

export class ProviderError extends AppError {
 constructor(public provider: ProviderName, public model: string, public upstreamStatus: number | undefined, public upstreamCode: string, public safeMessage: string, status = 502) {
  super(status,'PROVIDER_ERROR','AI provider unavailable');
 }
}

export async function providerFailure(provider: ProviderName, model: string, response: Response): Promise<ProviderError> {
 let code = 'HTTP_' + response.status, message = '';
 try {
  const raw = (await response.text()).slice(0,4000);
  try {
   const parsed = JSON.parse(raw) as { error?: { code?: string | number; status?: string; type?: string; message?: string } } | { error?: string }[];
   const e = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
   if (e && typeof e === 'object') { code = String(e.status ?? e.code ?? e.type ?? code); message = e.message ?? ''; }
   else if (typeof e === 'string') message = e;
  } catch { message = raw; }
 } catch { /* body unreadable */ }
 return new ProviderError(provider,model,response.status,redact(code).slice(0,80),redact(message),response.status === 429 ? 429 : 502);
}

export function networkFailure(provider: ProviderName, model: string, error: unknown): ProviderError {
 if (error instanceof ProviderError) return error;
 const e = error as { name?: string; message?: string; cause?: { code?: string } };
 const code = e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'TIMEOUT' : (e?.cause?.code ?? 'NETWORK_ERROR');
 return new ProviderError(provider,model,undefined,String(code).slice(0,80),redact(e?.message ?? ''),504);
}
