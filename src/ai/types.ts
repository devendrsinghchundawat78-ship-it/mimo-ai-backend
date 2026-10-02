export type Capability = 'chat' | 'summarize' | 'extract' | 'classify' | 'generate-tags' | 'search' | 'process-save' | 'link-details';
export type ProviderName = 'gemini1' | 'gemini2' | 'groq';
export interface Message { role: 'user' | 'assistant'; content: string }
export interface AIRequest { userId: string; capability: Capability; messages: Message[]; system: string; json: boolean; videoUrl?: string; timeoutMs?: number }
export interface AIResult { text: string; provider: ProviderName; model: string; inputTokens: number; outputTokens: number }
export interface AIProvider { name: ProviderName; supportsVideo?: boolean; modelFor?(request: AIRequest): string; generate(request: AIRequest, signal: AbortSignal): Promise<AIResult> }
export interface ProcessedSave { summary: string; category: string; tags: string[]; usefulInfo: string[] }
export interface SaveRow { id: string; user_id: string; url: string | null; title: string | null; content: string | null; ai_result?: ProcessedSave }
export interface ProcessingJob { id: string; user_id: string; save_id: string; status: 'queued'|'processing'|'completed'|'failed'; attempts: number; updated_at: string; result: ProcessedSave | null; error_code: string | null }

export interface LinkMetadata {
  title?: string;
  description?: string;
  imageUrl?: string;
  author?: string;
  publishedAt?: string;
  siteName?: string;
}

export interface LinkEntity {
  name: string;
  type: string;
}

export interface LinkEvidence {
  claim: string;
  source: string;
}

export interface LinkAnalysis {
  title: string;
  summary: string;
  key_takeaways: string[];
  topics: string[];
  tags: string[];
  content_type: string;
  entities: LinkEntity[];
  evidence: LinkEvidence[];
  suggested_collection: string;
  confidence: number;
}

export interface LinkDetailsResponse {
  ok: true;
  url: string;
  canonicalUrl: string;
  platform: string;
  metadata: LinkMetadata;
  analysis: LinkAnalysis;
  source: 'railway-primary' | 'supabase-ai-fallback';
}
