/**
 * Tier 2: Web-search fallback
 *
 * Uses the OpenAI Responses API with web_search_preview to browse the public
 * PDF report URL and extract metrics directly. Runs only when Tier 1 fails.
 *
 * Key fix vs previous implementation: response text is extracted from the
 * output array, not response.output_text, which is unreliable when tools fire.
 */
import type { MetricDef, TierStep, Metric, ResolvedTerms } from "../types";
import { buildPrompt, callWebSearch, MODELS } from "../llm";
import * as trace from "../trace";

export interface Tier2Result {
  outputs: Record<string, Metric>;
  step: TierStep;
}

export async function runTier2(
  reportUrl: string,
  metrics: MetricDef[],
  resolvedTerms: ResolvedTerms,
  ctx?: trace.TraceCtx | null
): Promise<Tier2Result> {
  const span = trace.span(ctx, "parser.tier2", { report_url: reportUrl, metric_keys: metrics.map((m) => m.key) });

  const prompt = `${buildPrompt(metrics, resolvedTerms)}

REPORT URL:
${reportUrl}

Instructions:
- Use web_search_preview to inspect the public PDF report at the URL above.
- Search across the entire report for the exact metric labels listed above.
- Prefer company-specific labels first, then the aliases.
- Return only the JSON output.`;

  const result = await callWebSearch(prompt, metrics);

  const extractedKeys = metrics.filter((m) => result.outputs[m.key]?.value != null).map((m) => m.key);
  const accepted = result.confidence === "high" || result.confidence === "medium";

  trace.generation(ctx, "llm.tier2_web_search", MODELS.tier2, prompt, result.raw);
  trace.endSpan(span, {
    report_url: reportUrl,
    confidence: result.confidence,
    accepted,
    extracted_keys: extractedKeys,
  }, extractedKeys.length === 0 ? { level: "WARNING" } : undefined);

  return {
    outputs: result.outputs,
    step: {
      tier: "fallback_full_report",
      model: MODELS.tier2,
      confidence: result.confidence,
      accepted,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      group: metrics.map((m) => m.key).join("+"),
    },
  };
}
