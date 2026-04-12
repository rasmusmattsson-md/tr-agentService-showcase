import { describe, it, expect } from "vitest";
import {
  sanitizeString,
  normalizeMetric,
  normalizeSharesMetric,
  parseReportHint,
  parseReportRange,
  deriveEpraNrv,
  deriveMarketValuePerSqm,
  derivePropertyValueChangePct,
} from "../../competitor-intel/utils/tools";

// ─────────────────────────────────────────────
// sanitizeString
// ─────────────────────────────────────────────
describe("sanitizeString", () => {
  it("returns null for null input", () => {
    expect(sanitizeString(null)).toBeNull();
  });

  it("strips null bytes", () => {
    expect(sanitizeString("hello\u0000world")).toBe("helloworld");
  });

  it("strips other control chars but keeps tab, newline, CR", () => {
    expect(sanitizeString("a\u0007b\tc\nd")).toBe("ab\tc\nd");
  });

  it("passes through clean strings unchanged", () => {
    expect(sanitizeString("EPRA NRV: 250 SEK")).toBe("EPRA NRV: 250 SEK");
  });
});

// ─────────────────────────────────────────────
// normalizeMetric
// ─────────────────────────────────────────────
describe("normalizeMetric", () => {
  it("returns null value for missing input", () => {
    expect(normalizeMetric(undefined)).toEqual({ value: null, source: null });
  });

  it("returns null value for empty string", () => {
    expect(normalizeMetric({ value: "", source: null })).toEqual({ value: null, source: null });
  });

  it("parses a plain integer", () => {
    expect(normalizeMetric({ value: "250", source: "EPRA NRV: 250 SEK" })).toEqual({
      value: 250,
      source: "EPRA NRV: 250 SEK",
    });
  });

  it("parses a decimal with comma separator", () => {
    expect(normalizeMetric({ value: "1,5", source: null })).toEqual({ value: 1.5, source: null });
  });

  it("parses a negative number", () => {
    expect(normalizeMetric({ value: "-42", source: null })).toEqual({ value: -42, source: null });
  });

  it("treats space-separated 3-digit groups as thousands separator", () => {
    // "250 300" → 250,300 — valid Swedish thousands format
    expect(normalizeMetric({ value: "250 300", source: null })).toEqual({ value: 250300, source: null });
  });

  it("returns null for two distinct decimal values (genuinely ambiguous)", () => {
    // "1.5 2.5" — two separate decimals, not a thousands format
    expect(normalizeMetric({ value: "1.5 2.5", source: null })).toEqual({ value: null, source: null });
  });

  it("handles thousands separator (space)", () => {
    expect(normalizeMetric({ value: "1 500", source: null })).toEqual({ value: 1500, source: null });
  });
});

// ─────────────────────────────────────────────
// normalizeSharesMetric — unit multiplier logic
// ─────────────────────────────────────────────
describe("normalizeSharesMetric", () => {
  it("returns null for missing input", () => {
    expect(normalizeSharesMetric(undefined)).toEqual({ value: null, source: null });
  });

  it("applies ×1000 when source says 'thousand'", () => {
    const result = normalizeSharesMetric({
      value: "50",
      source: "Number of shares (thousand): 50",
    });
    expect(result.value).toBe(50_000);
  });

  it("applies ×1,000,000 when source says 'million'", () => {
    const result = normalizeSharesMetric({
      value: "2",
      source: "Shares outstanding (million): 2",
    });
    expect(result.value).toBe(2_000_000);
  });

  it("does not double-scale if value is already large", () => {
    // Value is 50,000,000 — clearly already in absolute units
    const result = normalizeSharesMetric({
      value: "50000000",
      source: "Antal aktier (thousand)",
    });
    expect(result.value).toBe(50_000_000);
  });

  it("handles Swedish 'tusen' multiplier", () => {
    const result = normalizeSharesMetric({
      value: "100",
      source: "Antal aktier (tusental): 100",
    });
    expect(result.value).toBe(100_000);
  });

  it("returns value unchanged when no multiplier in source", () => {
    const result = normalizeSharesMetric({
      value: "1234567",
      source: "Number of shares: 1,234,567",
    });
    expect(result.value).toBe(1_234_567);
  });
});

// ─────────────────────────────────────────────
// parseReportHint
// ─────────────────────────────────────────────
describe("parseReportHint", () => {
  it("returns null for empty/null input", () => {
    expect(parseReportHint(null)).toBeNull();
    expect(parseReportHint("")).toBeNull();
    expect(parseReportHint("latest")).toBeNull();
  });

  it("parses year only", () => {
    expect(parseReportHint("2023")).toEqual({ year: 2023, type: undefined });
  });

  it("parses Q1 with year", () => {
    expect(parseReportHint("Q1 2024")).toEqual({ year: 2024, type: "Q1" });
  });

  it("parses Q3 lowercase", () => {
    expect(parseReportHint("q3 2022")).toEqual({ year: 2022, type: "Q3" });
  });

  it("parses interim", () => {
    expect(parseReportHint("interim 2023")).toEqual({ year: 2023, type: "interim" });
  });

  it("parses delårsrapport (Swedish)", () => {
    expect(parseReportHint("delårs 2023")).toEqual({ year: 2023, type: "interim" });
  });

  it("parses annual", () => {
    expect(parseReportHint("annual 2022")).toEqual({ year: 2022, type: "annual" });
  });

  it("parses årsrapport (Swedish)", () => {
    expect(parseReportHint("årsrapport 2021")).toEqual({ year: 2021, type: "annual" });
  });
});

// ─────────────────────────────────────────────
// parseReportRange
// ─────────────────────────────────────────────
describe("parseReportRange", () => {
  it("returns null for empty input", () => {
    expect(parseReportRange(null)).toBeNull();
    expect(parseReportRange("")).toBeNull();
  });

  it("parses a standard ISO range with 'to'", () => {
    expect(parseReportRange("2023-01-01 to 2023-12-31")).toEqual({
      start: "2023-01-01",
      end: "2023-12-31",
    });
  });

  it("parses a range with dash separator", () => {
    expect(parseReportRange("2023-01-01 - 2023-06-30")).toEqual({
      start: "2023-01-01",
      end: "2023-06-30",
    });
  });

  it("parses a range with en-dash", () => {
    expect(parseReportRange("2023-01-01–2023-12-31")).toEqual({
      start: "2023-01-01",
      end: "2023-12-31",
    });
  });

  it("returns null for malformed dates", () => {
    expect(parseReportRange("Jan 2023 to Dec 2023")).toBeNull();
  });
});

// ─────────────────────────────────────────────
// deriveEpraNrv
// ─────────────────────────────────────────────
describe("deriveEpraNrv", () => {
  const base = {
    equity: 1_000,
    pref_equity: -200,   // pref equity is typically negative in books
    derivatives_balance_sheet: 50,
    deferred_tax_balance_sheet: 100,
    number_of_shares: 10,
  };

  it("returns null if any input is null", () => {
    expect(deriveEpraNrv({ ...base, equity: null })).toBeNull();
    expect(deriveEpraNrv({ ...base, number_of_shares: null })).toBeNull();
  });

  it("returns null for zero shares (avoid division by zero)", () => {
    expect(deriveEpraNrv({ ...base, number_of_shares: 0 })).toBeNull();
  });

  it("computes correct per-share value", () => {
    // equity(1000) - abs(pref_equity)(200) + derivatives(50) + deferred_tax(100) = 950
    // 950 / 10 shares = 95
    expect(deriveEpraNrv(base)).toBeCloseTo(95);
  });
});

// ─────────────────────────────────────────────
// deriveMarketValuePerSqm
// ─────────────────────────────────────────────
describe("deriveMarketValuePerSqm", () => {
  it("returns null for null inputs", () => {
    expect(deriveMarketValuePerSqm(null, 100)).toBeNull();
    expect(deriveMarketValuePerSqm(500, null)).toBeNull();
  });

  it("returns null for zero area (avoid division by zero)", () => {
    expect(deriveMarketValuePerSqm(1_000_000, 0)).toBeNull();
  });

  it("returns null for negative area", () => {
    expect(deriveMarketValuePerSqm(1_000_000, -100)).toBeNull();
  });

  it("computes correct value", () => {
    expect(deriveMarketValuePerSqm(1_000_000, 5_000)).toBeCloseTo(200);
  });
});

// ─────────────────────────────────────────────
// derivePropertyValueChangePct
// ─────────────────────────────────────────────
describe("derivePropertyValueChangePct", () => {
  it("returns null for null inputs", () => {
    expect(derivePropertyValueChangePct(null, 1000)).toBeNull();
    expect(derivePropertyValueChangePct(100, null)).toBeNull();
  });

  it("returns null when previous value is zero (avoid division by zero)", () => {
    // previousValue = marketValue - valueChange = 100 - 100 = 0
    expect(derivePropertyValueChangePct(100, 100)).toBeNull();
  });

  it("computes a positive change correctly", () => {
    // valueChange=100, marketValue=1100 → previousValue=1000, pct=0.1
    expect(derivePropertyValueChangePct(100, 1100)).toBeCloseTo(0.1);
  });

  it("computes a negative change correctly", () => {
    // valueChange=-50, marketValue=950 → previousValue=1000, pct=-0.05
    expect(derivePropertyValueChangePct(-50, 950)).toBeCloseTo(-0.05);
  });
});
