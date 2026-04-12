/**
 * Resolves company-specific metric labels before Tier 1 runs.
 *
 * Flow:
 * 1. Find definition pages in the PDF
 * 2. Render each page and extract definition blocks via vision LLM
 * 3. Embed each block title and search Supabase for metric matches
 * 4. Apply per-metric guardrails (e.g. epra_nrv must say "per aktie")
 * 5. Return ResolvedTerms: metricKey → [company label, ...default keywords]
 *
 * Falls back to default keywords from MetricDef if no definitions are found
 * or none pass the similarity threshold.
 */
import { createClient } from "@supabase/supabase-js";
import type { MetricDef, PdfData, ResolvedTerms } from "../types";
import { callDefinitionExtraction, embed, DEFINITION_MATCH_THRESHOLD, MAX_DEFINITION_PAGES } from "../llm";
import { findDefinitionPages, renderPages } from "./pdf";
import * as trace from "../trace";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface DefinitionBlock {
  title: string;
  description: string;
  pageNumber: number;
}

function passesGuardrails(metricKey: string, block: DefinitionBlock): boolean {
  if (metricKey === "epra_nrv") {
    const text = `${block.title} ${block.description}`;
    return /\bper aktie\b|\bkr\s*\/\s*aktie\b|\bstamaktie\b|\bcommon share\b|\bper share\b/i.test(text);
  }
  return true;
}

async function searchDefinitions(queryText: string, topK = 5): Promise<Array<{ canonical_key: string; similarity: number }>> {
  const embedding = await embed(queryText);
  if (!embedding.length) return [];

  const { data, error } = await supabase.rpc("match_metric_definitions", {
    query_embedding: embedding,
    match_count: topK,
    filter_canonical_key: null,
  });

  if (error || !Array.isArray(data)) return [];
  return data as Array<{ canonical_key: string; similarity: number }>;
}

export interface DefinitionResolution {
  resolvedTerms: ResolvedTerms;
  definitionPages: number[];
}

export async function resolveTerms(
  pdfData: PdfData,
  metrics: MetricDef[],
  ctx?: trace.TraceCtx | null
): Promise<DefinitionResolution> {
  // Start with defaults — this is what we return if anything goes wrong
  const resolved: ResolvedTerms = Object.fromEntries(metrics.map((m) => [m.key, m.keywords]));

  const defPages = findDefinitionPages(pdfData.pages).slice(0, MAX_DEFINITION_PAGES);
  const span = trace.span(ctx, "parser.definitions", { definition_pages: defPages, metric_keys: metrics.map((m) => m.key) });

  if (defPages.length === 0) {
    trace.endSpan(span, { route: "no_definition_pages", resolved_keys: [] });
    return { resolvedTerms: resolved, definitionPages: [] };
  }

  // Extract definition blocks page by page so each block gets the correct page number
  const blocks: DefinitionBlock[] = [];
  for (const pageNum of defPages) {
    const [image] = await renderPages(pdfData.pdf, [pageNum]);
    const raw = await callDefinitionExtraction([image]);
    for (const b of raw) {
      if (typeof b.title === "string" && typeof b.description === "string" && b.title && b.description) {
        blocks.push({ title: b.title.trim(), description: b.description.trim(), pageNumber: pageNum });
      }
    }
  }

  // Embed the description to find the matching canonical metric (description ↔ stored definition vectors).
  // The title is used later as the company-specific keyword — not for matching.
  const bestByMetric = new Map<string, { title: string; similarity: number }>();

  for (const block of blocks) {
    const matches = await searchDefinitions(block.description);
    const best = matches[0];
    if (!best || best.similarity < DEFINITION_MATCH_THRESHOLD) continue;
    if (!metrics.some((m) => m.key === best.canonical_key)) continue;
    if (!passesGuardrails(best.canonical_key, block)) continue;

    const current = bestByMetric.get(best.canonical_key);
    if (!current || best.similarity > current.similarity) {
      bestByMetric.set(best.canonical_key, { title: block.title, similarity: best.similarity });
    }
  }

  // Prepend company-specific label to the keyword list for each matched metric
  for (const [metricKey, match] of bestByMetric) {
    const defaults = metrics.find((m) => m.key === metricKey)?.keywords ?? [];
    resolved[metricKey] = [match.title, ...defaults.filter((k) => k !== match.title)];
  }

  trace.endSpan(span, {
    definition_pages: defPages,
    blocks_extracted: blocks.length,
    resolved_keys: [...bestByMetric.keys()],
    default_keys: metrics.filter((m) => !bestByMetric.has(m.key)).map((m) => m.key),
  });

  return { resolvedTerms: resolved, definitionPages: defPages };
}
