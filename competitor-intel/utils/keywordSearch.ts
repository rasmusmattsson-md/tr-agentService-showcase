import type { PageText } from "./types";

const CONTEXT_RADIUS = 150;

export interface KeywordMatch {
  metric: string;
  keyword: string;
  pageNumber: number;
  context: string;
}

/** Scans pages for each keyword and returns all matches with surrounding context. */
export function searchKeywords(
  pages: PageText[],
  keywords: Record<string, string[]>
): KeywordMatch[] {
  const matches: KeywordMatch[] = [];

  for (const [metric, kws] of Object.entries(keywords)) {
    for (const keyword of kws) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "gi");

      for (const page of pages) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(page.text)) !== null) {
          const start = Math.max(0, match.index - CONTEXT_RADIUS);
          const end = Math.min(page.text.length, match.index + match[0].length + CONTEXT_RADIUS);
          matches.push({
            metric,
            keyword,
            pageNumber: page.pageNumber,
            context: page.text.slice(start, end),
          });
        }
      }
    }
  }

  return matches;
}

interface PruneOptions {
  maxTotal?: number;
  maxPerMetric?: number;
  maxPerPagePerMetric?: number;
}

/** Prunes keyword matches by deduplication and configurable caps. */
export function pruneKeywordMatches(
  matches: KeywordMatch[],
  options: PruneOptions = {}
): KeywordMatch[] {
  const { maxTotal = Infinity, maxPerMetric = 8, maxPerPagePerMetric = Infinity } = options;

  const result: KeywordMatch[] = [];
  const seenContexts = new Set<string>();
  const perMetric = new Map<string, number>();
  const perPageMetric = new Map<string, number>();

  for (const match of matches) {
    if (result.length >= maxTotal) break;

    if (seenContexts.has(match.context)) continue;

    const metricCount = perMetric.get(match.metric) ?? 0;
    if (metricCount >= maxPerMetric) continue;

    const pageMetricKey = `${match.pageNumber}:${match.metric}`;
    const pageMetricCount = perPageMetric.get(pageMetricKey) ?? 0;
    if (pageMetricCount >= maxPerPagePerMetric) continue;

    seenContexts.add(match.context);
    perMetric.set(match.metric, metricCount + 1);
    perPageMetric.set(pageMetricKey, pageMetricCount + 1);
    result.push(match);
  }

  return result;
}

/** Formats keyword matches as labelled snippets for Tier 1 prompt injection.
 *  Deduplicates identical page+context combos. */
export function buildSnippetsForTier1(matches: KeywordMatch[]): string {
  if (matches.length === 0) return "";

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const match of matches) {
    const key = `${match.pageNumber}:${match.context}`;
    if (seen.has(key)) continue;
    seen.add(key);

    lines.push(`[Page ${match.pageNumber} | ${match.metric} | "${match.keyword}"]`);
    lines.push(match.context);
    lines.push("");
  }

  return lines.join("\n").trim();
}

/** Returns full text of pages that had keyword matches, for Tier 2 prompts. */
export function buildPagesForTier2(pages: PageText[], matches: KeywordMatch[]): string {
  if (matches.length === 0) return "";

  const matchedPageNumbers = new Set(matches.map((m) => m.pageNumber));
  const matched = pages.filter((p) => matchedPageNumbers.has(p.pageNumber));

  return matched.map((p) => `=== PAGE ${p.pageNumber} ===\n${p.text}`).join("\n\n");
}
