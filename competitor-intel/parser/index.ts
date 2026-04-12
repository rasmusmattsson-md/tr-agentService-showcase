/**
 * Parser entry point.
 *
 * Loads the PDF, runs Tier 1 (keyword + vision), and falls back to
 * Tier 2 (web search) if confidence is insufficient.
 * Every decision point is logged to Langfuse via trace.ts.
 */
import type { MetricDef, ParseResult } from "../types";
import { loadPdf } from "./pdf";
import { runTier1 } from "./tier1";
import { runTier2 } from "./tier2";
import * as trace from "../trace";

export async function parseMetrics(
  metrics: MetricDef[],
  reportUrl: string,
  ctx?: trace.TraceCtx | null
): Promise<ParseResult> {
  const span = trace.span(ctx, "parser.run", { report_url: reportUrl, metric_keys: metrics.map((m) => m.key) });

  const pdfData = await loadPdf(reportUrl);
  const tier1 = await runTier1(pdfData, metrics, ctx);

  // Tier 1 success — high or medium confidence
  if (tier1.step.accepted) {
    const result = buildResult(pdfData.pages.length, tier1.definitionPages, tier1.candidatePages, tier1.outputs, [tier1.step], "tier1");
    trace.endSpan(span, { route: "tier1_success", extracted_keys: result.diagnostics.extractedMetricKeys });
    return result;
  }

  // Tier 1 failed — escalate to Tier 2
  const tier2 = await runTier2(reportUrl, metrics, tier1.resolvedTerms, ctx);
  const result = buildResult(pdfData.pages.length, tier1.definitionPages, tier1.candidatePages, tier2.outputs, [tier1.step, tier2.step], "tier2_fallback");

  trace.endSpan(span, {
    route: "tier2_fallback",
    fallback_reason: `tier1_confidence_${tier1.step.confidence ?? "none"}`,
    extracted_keys: result.diagnostics.extractedMetricKeys,
  }, { level: "WARNING" });

  return result;
}

function buildResult(
  pageCount: number,
  definitionPages: number[],
  candidatePages: number[],
  outputs: Record<string, ReturnType<typeof Object.fromEntries>[string]>,
  steps: ParseResult["steps"],
  route: string
): ParseResult {
  const extractedMetricKeys = Object.entries(outputs)
    .filter(([, m]) => m?.value != null)
    .map(([key]) => key);

  const fallbackMetricKeys = steps.some((s) => s.tier === "fallback_full_report")
    ? Object.entries(outputs).filter(([, m]) => m?.value == null).map(([key]) => key)
    : [];

  return {
    outputs,
    steps,
    diagnostics: {
      pageCount,
      definitionPages,
      candidatePages,
      extractedMetricKeys,
      fallbackMetricKeys,
      route,
    },
  };
}
