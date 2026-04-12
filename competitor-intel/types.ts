// ─── Domain ───────────────────────────────────────────────────────────────────

export interface MetricDef {
  key: string;
  group: string;
  unit: string;
  keywords: string[];
  description: string;
  optional?: boolean;
  rules?: string[];
}

export interface Metric {
  value: string | null;
  source: string | null;
}

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface PdfData {
  bytes: Uint8Array;
  pages: PageText[];
  pdf: any;
}

/** metricKey → [company-specific label, ...fallback keywords] */
export type ResolvedTerms = Record<string, string[]>;

// ─── Extraction ───────────────────────────────────────────────────────────────

export interface TierStep {
  tier: string;
  model: string;
  confidence: string | null;
  accepted: boolean;
  inputTokens: number;
  outputTokens: number;
  group: string;
}

export interface ParseResult {
  outputs: Record<string, Metric>;
  steps: TierStep[];
  diagnostics: {
    pageCount: number;
    definitionPages: number[];
    candidatePages: number[];
    extractedMetricKeys: string[];
    fallbackMetricKeys: string[];
    route: string;
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export type ExtractionSignal = "clean" | "partial_fallback" | "full_fallback" | "failed";

export interface CompanyInput {
  id: string;
  name: string;
  website_url: string;
}

export interface RunContext {
  asOfDate?: string | null;
  traceId?: string | null;
  parentLangfuseObservationId?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  parameters?: Record<string, unknown>;
  definition?: Record<string, unknown>;
}

export interface OrchestratorResult {
  companyId: string;
  runId: string;
  reportUrl: string | null;
  metrics: Record<string, Metric>;
  signal: ExtractionSignal;
  steps: TierStep[];
  cachedMetricKeys: string[];
  error: string | null;
  artifactRunId: string | null;
}
