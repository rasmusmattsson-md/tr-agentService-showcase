import { describe, it, expect } from "vitest";
import {
  searchKeywords,
  pruneKeywordMatches,
  buildSnippetsForTier1,
  buildPagesForTier2,
} from "../../competitor-intel/utils/keywordSearch";
import type { PageText } from "../../competitor-intel/utils/types";

// ─────────────────────────────────────────────
// searchKeywords
// ─────────────────────────────────────────────
describe("searchKeywords", () => {
  const pages: PageText[] = [
    { pageNumber: 1, text: "EPRA NRV per share was 250 SEK as of Q3 2023." },
    { pageNumber: 2, text: "Loan-to-value ratio is 42%. Interest coverage is 3.2x." },
    { pageNumber: 3, text: "No relevant data on this page." },
  ];

  it("finds a keyword on the correct page", () => {
    const matches = searchKeywords(pages, { epra_nrv: ["EPRA NRV"] });
    expect(matches).toHaveLength(1);
    expect(matches[0].pageNumber).toBe(1);
    expect(matches[0].metric).toBe("epra_nrv");
  });

  it("is case-insensitive", () => {
    const matches = searchKeywords(pages, { ltv: ["loan-to-value"] });
    expect(matches).toHaveLength(1);
  });

  it("returns multiple matches when keyword appears multiple times", () => {
    const pages2: PageText[] = [
      { pageNumber: 1, text: "EPRA NRV was 250. Prior year EPRA NRV was 230." },
    ];
    const matches = searchKeywords(pages2, { epra_nrv: ["EPRA NRV"] });
    expect(matches).toHaveLength(2);
  });

  it("returns empty array when no keywords match", () => {
    const matches = searchKeywords(pages, { revenue: ["revenue", "intäkter"] });
    expect(matches).toHaveLength(0);
  });

  it("returns matches for multiple metrics simultaneously", () => {
    const matches = searchKeywords(pages, {
      epra_nrv: ["EPRA NRV"],
      ltv: ["Loan-to-value"],
    });
    expect(matches).toHaveLength(2);
    const metrics = matches.map((m) => m.metric);
    expect(metrics).toContain("epra_nrv");
    expect(metrics).toContain("ltv");
  });

  it("context window is ~300 chars (CONTEXT_RADIUS=150 each side)", () => {
    const matches = searchKeywords(pages, { epra_nrv: ["EPRA NRV"] });
    // Page 1 text is short so we get the full text; just assert it contains the keyword
    expect(matches[0].context).toContain("EPRA NRV");
  });

  it("handles empty pages array", () => {
    const matches = searchKeywords([], { epra_nrv: ["EPRA NRV"] });
    expect(matches).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// pruneKeywordMatches
// ─────────────────────────────────────────────
describe("pruneKeywordMatches", () => {
  function makeMatch(metric: string, pageNumber: number, context: string) {
    return { metric, keyword: metric, pageNumber, context };
  }

  it("limits total matches to maxTotal across metrics", () => {
    // Use multiple metrics so per-metric cap (default 8) doesn't kick in first
    const matches = Array.from({ length: 50 }, (_, i) =>
      makeMatch(`metric_${i}`, i + 1, `context ${i}`)
    );
    const pruned = pruneKeywordMatches(matches, { maxTotal: 10 });
    expect(pruned).toHaveLength(10);
  });

  it("limits matches per metric to maxPerMetric", () => {
    const matches = Array.from({ length: 20 }, (_, i) =>
      makeMatch("revenue", i + 1, `context ${i}`)
    );
    const pruned = pruneKeywordMatches(matches, { maxPerMetric: 5 });
    const revenueMatches = pruned.filter((m) => m.metric === "revenue");
    expect(revenueMatches.length).toBeLessThanOrEqual(5);
  });

  it("limits matches per page per metric to maxPerPagePerMetric", () => {
    const matches = [
      makeMatch("revenue", 1, "context a"),
      makeMatch("revenue", 1, "context b"),
      makeMatch("revenue", 1, "context c"),
    ];
    const pruned = pruneKeywordMatches(matches, { maxPerPagePerMetric: 2 });
    const page1 = pruned.filter((m) => m.pageNumber === 1);
    expect(page1.length).toBeLessThanOrEqual(2);
  });

  it("deduplicates identical contexts", () => {
    const matches = [
      makeMatch("revenue", 1, "same context"),
      makeMatch("revenue", 1, "same context"),
    ];
    const pruned = pruneKeywordMatches(matches);
    expect(pruned).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(pruneKeywordMatches([])).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// buildSnippetsForTier1
// ─────────────────────────────────────────────
describe("buildSnippetsForTier1", () => {
  it("returns empty string for empty matches", () => {
    expect(buildSnippetsForTier1([])).toBe("");
  });

  it("formats match as [Page N | metric | keyword] header + context", () => {
    const matches = [
      { metric: "epra_nrv", keyword: "EPRA NRV", pageNumber: 3, context: "EPRA NRV: 250 SEK" },
    ];
    const output = buildSnippetsForTier1(matches);
    expect(output).toContain('[Page 3 | epra_nrv | "EPRA NRV"]');
    expect(output).toContain("EPRA NRV: 250 SEK");
  });

  it("deduplicates identical page+context combos", () => {
    const matches = [
      { metric: "epra_nrv", keyword: "EPRA NRV", pageNumber: 1, context: "same" },
      { metric: "epra_nrv", keyword: "epra nrv", pageNumber: 1, context: "same" },
    ];
    const output = buildSnippetsForTier1(matches);
    // Should only appear once
    expect(output.match(/same/g)?.length).toBe(1);
  });
});

// ─────────────────────────────────────────────
// buildPagesForTier2
// ─────────────────────────────────────────────
describe("buildPagesForTier2", () => {
  const pages: PageText[] = [
    { pageNumber: 1, text: "Page one content." },
    { pageNumber: 2, text: "Page two content." },
    { pageNumber: 3, text: "Page three content." },
  ];

  it("returns only pages that had keyword matches", () => {
    const matches = [
      { metric: "epra_nrv", keyword: "EPRA NRV", pageNumber: 2, context: "..." },
    ];
    const output = buildPagesForTier2(pages, matches);
    expect(output).toContain("Page two content.");
    expect(output).not.toContain("Page one content.");
    expect(output).not.toContain("Page three content.");
  });

  it("includes === PAGE N === header", () => {
    const matches = [{ metric: "ltv", keyword: "ltv", pageNumber: 1, context: "..." }];
    const output = buildPagesForTier2(pages, matches);
    expect(output).toContain("=== PAGE 1 ===");
  });

  it("returns empty string when no matches", () => {
    const output = buildPagesForTier2(pages, []);
    expect(output).toBe("");
  });

  it("includes multiple matched pages", () => {
    const matches = [
      { metric: "a", keyword: "a", pageNumber: 1, context: "..." },
      { metric: "b", keyword: "b", pageNumber: 3, context: "..." },
    ];
    const output = buildPagesForTier2(pages, matches);
    expect(output).toContain("Page one content.");
    expect(output).toContain("Page three content.");
    expect(output).not.toContain("Page two content.");
  });
});
