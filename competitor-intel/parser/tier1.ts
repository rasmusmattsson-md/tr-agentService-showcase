/**
 * Tier 1: PDF-based extraction
 *
 * 1. Resolve company-specific metric labels via definitions.ts (RAG)
 * 2. Scan page text for resolved keywords → candidate pages
 * 3. Render candidate pages as images
 * 4. Vision LLM extracts metric values
 */
import type { MetricDef, PdfData, TierStep, Metric, ResolvedTerms } from "../types";
import { buildPrompt, callVision, MODELS, MAX_CANDIDATE_PAGES } from "../llm";
import { renderPages } from "./pdf";
import { resolveTerms } from "./definitions";
import * as trace from "../trace";

function locateCandidatePages(
  pdfData: PdfData,
  resolvedTerms: ResolvedTerms,
  excludePages: number[]
): number[] {
  const excluded = new Set(excludePages);
  const allTerms = Object.values(resolvedTerms).flat().filter(Boolean);

  return pdfData.pages
    .filter((p) => !excluded.has(p.pageNumber))
    .filter((p) => allTerms.some((term) => p.text.toLowerCase().includes(term.toLowerCase())))
    .map((p) => p.pageNumber)
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => a - b)
    .slice(0, MAX_CANDIDATE_PAGES);
}

export interface Tier1Result {
  outputs: Record<string, Metric>;
  step: TierStep;
  resolvedTerms: ResolvedTerms;
  definitionPages: number[];
  candidatePages: number[];
}

export async function runTier1(
  pdfData: PdfData,
  metrics: MetricDef[],
  ctx?: trace.TraceCtx | null
): Promise<Tier1Result> {
  const span = trace.span(ctx, "parser.tier1", { metric_keys: metrics.map((m) => m.key) });
  const nullOutputs = Object.fromEntries(metrics.map((m) => [m.key, { value: null, source: null }]));
  const makeStep = (confidence: string | null, usage = { inputTokens: 0, outputTokens: 0 }): TierStep => ({
    tier: "tier_1_keyword",
    model: MODELS.tier1,
    confidence,
    accepted: confidence === "high" || confidence === "medium",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    group: metrics.map((m) => m.key).join("+"),
  });

  // Step 1: Resolve company-specific labels (RAG against definition pages)
  const { resolvedTerms, definitionPages } = await resolveTerms(pdfData, metrics, ctx);

  // Step 2: Locate candidate pages (keyword scan, excluding definition pages)
  const candidatePages = locateCandidatePages(pdfData, resolvedTerms, definitionPages);

  if (candidatePages.length === 0) {
    trace.endSpan(span, { route: "no_candidate_pages", definition_pages: definitionPages }, { level: "WARNING" });
    return { outputs: nullOutputs, step: makeStep(null), resolvedTerms, definitionPages, candidatePages: [] };
  }

  // Step 3: Render pages and run vision extraction
  const images = await renderPages(pdfData.pdf, candidatePages);
  const prompt = buildPrompt(metrics, resolvedTerms);
  const result = await callVision(prompt, images, metrics);

  const accepted = result.confidence === "high" || result.confidence === "medium";
  const extractedKeys = metrics.filter((m) => result.outputs[m.key]?.value != null).map((m) => m.key);

  trace.generation(ctx, "llm.tier1_vision", MODELS.tier1, prompt, result.raw);
  trace.endSpan(span, {
    route: accepted ? "tier1_success" : "tier1_low_confidence",
    candidate_pages: candidatePages,
    definition_pages: definitionPages,
    confidence: result.confidence,
    extracted_keys: extractedKeys,
  }, accepted ? undefined : { level: "WARNING" });

  return {
    outputs: result.outputs,
    step: makeStep(result.confidence, { inputTokens: result.inputTokens, outputTokens: result.outputTokens }),
    resolvedTerms,
    definitionPages,
    candidatePages,
  };
}
