/**
 * Single file that owns all OpenAI communication.
 * - callVision()     → chat.completions (Tier 1, definition extraction)
 * - callWebSearch()  → responses API with web_search_preview (Tier 2)
 * - buildPrompt()    → shared prompt builder
 * - validate()       → post-extraction guardrails
 */
import OpenAI from "openai";
import type { MetricDef, Metric, ResolvedTerms } from "./types";
import { sanitizeString } from "./utils";
import { logger } from "../src/logging/logger";

// ─── Config ───────────────────────────────────────────────────────────────────

export const MODELS = {
  tier1:      process.env.FIN_EXTRACT_MODEL            ?? "gpt-4o-mini",
  tier2:      process.env.FIN_EXTRACT_STRONG_MODEL     ?? "gpt-4o",
  definition: process.env.FIN_EXTRACT_DEFINITION_MODEL ?? "gpt-4o-mini",
  embedding:  process.env.FIN_EXTRACT_EMBEDDING_MODEL  ?? "text-embedding-3-small",
} as const;

export const DEFINITION_MATCH_THRESHOLD = Number(process.env.FIN_DEFINITION_MATCH_THRESHOLD ?? "0.78");
export const MAX_CANDIDATE_PAGES = 10;
export const MAX_DEFINITION_PAGES = 3;

// ─── Client ───────────────────────────────────────────────────────────────────

let _client: OpenAI | null = null;
export function openai(): OpenAI {
  return (_client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
}

// ─── Response parsing ─────────────────────────────────────────────────────────

/**
 * Extracts JSON from any LLM response string.
 * Handles prose before/after JSON, markdown code fences, and Responses API output arrays.
 * Logs and returns {} on failure — never throws.
 */
export function parseResponse(raw: string | null | undefined): Record<string, any> {
  if (!raw?.trim()) return {};
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.warn({ preview: raw.slice(0, 300) }, "llm.parseResponse: no JSON found");
    return {};
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    logger.warn({ preview: match[0].slice(0, 300) }, "llm.parseResponse: JSON parse failed");
    return {};
  }
}

/**
 * Extracts the final text content from a Responses API response.
 * The Responses API returns an output array; output_text is unreliable with tools.
 */
function extractResponseText(response: any): string | null {
  const items: any[] = response?.output ?? [];
  for (const item of [...items].reverse()) {
    if (item?.type === "message") {
      for (const part of item?.content ?? []) {
        if (part?.type === "output_text" && typeof part.text === "string") return part.text;
      }
    }
  }
  // Fallback: output_text shorthand (works when no tools were invoked)
  return typeof response?.output_text === "string" ? response.output_text : null;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

const EXTRACTION_RULES = `
GLOBAL PRINCIPLES (NON-NEGOTIABLE):
1. STRICTLY EXTRACTIVE — DO NOT calculate, divide, or infer.
2. UNIT NORMALIZATION is mechanical only:
   - "mkr" or "MSEK" → multiply by 1,000,000
   - "tkr" → multiply by 1,000
   - "kr" or "SEK" → no conversion
3. A metric ONLY exists if EXPLICITLY LABELED.
4. ALL values returned as TEXT (digits, comma/dot, optional minus). Remove units.
5. Source MUST be the exact text fragment containing the label and value.

CONFIDENCE:
- "high": label and value are unambiguous
- "medium": label present but value is ambiguous
- "low": not found or very uncertain
- "none": no relevant text found at all
`.trim();

/**
 * Builds the extraction prompt.
 * For Tier 1, pass resolvedTerms to surface the company-specific primary label.
 * For Tier 2 / definitions, resolvedTerms can be omitted (falls back to metric.keywords).
 */
export function buildPrompt(metrics: MetricDef[], resolvedTerms?: ResolvedTerms): string {
  const metricList = metrics.map((m) => {
    const terms = resolvedTerms?.[m.key] ?? m.keywords;
    const primary = terms[0];
    const aliases = terms.slice(1);
    const rulesBlock = m.rules?.length ? `\n  Rules: ${m.rules.join("; ")}` : "";
    const aliasBlock = aliases.length ? `\n  Aliases: ${aliases.join(" / ")}` : "";
    return `• ${m.key} (${m.unit}): ${m.description}\n  Label: ${primary}${aliasBlock}${rulesBlock}`;
  }).join("\n\n");

  const schemaFields = metrics
    .map((m) => `  "${m.key}": { "value": "<string or null>", "source": "<exact quote or null>" }`)
    .join(",\n");

  return `${EXTRACTION_RULES}\n\nMETRICS TO EXTRACT:\n${metricList}\n\nReturn JSON:\n{\n  "confidence": "high" | "medium" | "low" | "none",\n${schemaFields}\n}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function passesValidation(metric: MetricDef, candidate: Metric): boolean {
  if (candidate.value == null) return true;
  if (metric.key === "epra_nrv") {
    const ok = /\bper aktie\b|\bkr\s*\/\s*aktie\b|\bsek\s*\/\s*aktie\b|\bper share\b|\bstamaktie\b|\bcommon share\b/i.test(candidate.source ?? "");
    if (!ok) logger.warn({ source: candidate.source }, "llm.validate: epra_nrv rejected — no per-share indicator in source");
    return ok;
  }
  return true;
}

export function validate(metrics: MetricDef[], raw: Record<string, any>): Record<string, Metric> {
  const outputs: Record<string, Metric> = {};
  for (const m of metrics) {
    const candidate: Metric = {
      value: raw[m.key]?.value != null ? sanitizeString(String(raw[m.key].value)) : null,
      source: raw[m.key]?.source != null ? sanitizeString(String(raw[m.key].source)) : null,
    };
    outputs[m.key] = passesValidation(m, candidate) ? candidate : { value: null, source: null };
  }
  return outputs;
}

// ─── LLM calls ────────────────────────────────────────────────────────────────

export interface LlmResult {
  outputs: Record<string, Metric>;
  confidence: string | null;
  inputTokens: number;
  outputTokens: number;
  raw: Record<string, any>;
}

/** Tier 1 — vision extraction via chat.completions */
export async function callVision(
  prompt: string,
  images: string[],
  metrics: MetricDef[]
): Promise<LlmResult> {
  const response = await openai().chat.completions.create({
    model: MODELS.tier1,
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((b64) => ({
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${b64}`, detail: "low" as const },
        })),
      ],
    }],
  });

  const raw = parseResponse(response.choices[0]?.message.content);
  const { confidence, ...rest } = raw;
  return {
    outputs: validate(metrics, rest),
    confidence: confidence ?? null,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    raw,
  };
}

/** Definition extraction — vision via chat.completions, lower detail */
export async function callDefinitionExtraction(images: string[]): Promise<any[]> {
  const prompt = `Extract formal metric definition blocks from these financial report pages.

Return JSON:
{ "blocks": [{ "title": "<exact metric title>", "description": "<definition text>" }] }

Rules:
- Only extract formal definitions of named financial metrics (e.g. from a Definitions or Glossary section).
- Do NOT extract KPI highlights, bullet-point performance summaries, or results figures.
- Preserve the report's exact terminology. Do not translate or summarize.
- Ignore headers, footers, and page numbers.`;

  const response = await openai().chat.completions.create({
    model: MODELS.definition,
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((b64) => ({
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${b64}` },
        })),
      ],
    }],
  });

  const parsed = parseResponse(response.choices[0]?.message.content);
  return Array.isArray(parsed.blocks) ? parsed.blocks : [];
}

/** Tier 2 — web search fallback via Responses API */
export async function callWebSearch(prompt: string, metrics: MetricDef[]): Promise<LlmResult> {
  const response = await (openai() as any).responses.create({
    model: MODELS.tier2,
    tools: [{ type: "web_search_preview" }],
    input: prompt,
  });

  const text = extractResponseText(response);
  if (!text) {
    logger.warn("llm.callWebSearch: could not extract text from Responses API output");
  }

  const raw = parseResponse(text);
  const { confidence, ...rest } = raw;
  return {
    outputs: validate(metrics, rest),
    confidence: confidence ?? null,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    raw,
  };
}

/** Embed a text string for semantic search */
export async function embed(text: string): Promise<number[]> {
  const response = await openai().embeddings.create({
    model: MODELS.embedding,
    input: text.slice(0, 4000),
  });
  return response.data[0]?.embedding ?? [];
}
