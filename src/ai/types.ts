export type Capability = 'chat' | 'summarize' | 'extract' | 'classify' | 'generate-tags' | 'search' | 'process-save';
export type ProviderName = 'gemini1' | 'gemini2' | 'groq';
export interface Message { role: 'user' | 'assistant'; content: string }
export interface AIRequest { userId: string; capability: Capability; messages: Message[]; system: string; json: boolean }
export interface AIResult { text: string; provider: ProviderName; model: string; inputTokens: number; outputTokens: number }
export interface AIProvider { name: ProviderName; generate(request: AIRequest, signal: AbortSignal): Promise<AIResult> }
export interface ProcessedSave { summary: string; category: string; tags: string[]; usefulInfo: string[] }
export interface SaveRow { id: string; user_id: string; url: string | null; title: string | null; content: string | null; ai_result?: ProcessedSave }
export interface ProcessingJob { id: string; user_id: string; save_id: string; status: 'queued'|'processing'|'completed'|'failed'; attempts: number; updated_at: string; result: ProcessedSave | null; error_code: string | null }
