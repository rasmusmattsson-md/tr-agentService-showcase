import type { MetricDef } from "./types";

export const METRICS: Record<string, MetricDef> = {
  // ─── EPRA NRV ───────────────────────────────────────────────────────────────
  epra_nrv: {
    key: "epra_nrv",
    group: "epra_nrv",
    unit: "per_share",
    keywords: [
      "EPRA NRV", "EPRA NRV per aktie", "Långsiktigt substansvärde per aktie",
      "Substansvärde per aktie", "Substansvärde, kr/aktie", "EPRA NRV per share",
    ],
    description: `EPRA NRV (Net Reinstatement Value) per share. Source must explicitly say "per aktie", "kr/aktie", or "per share". Reject company-level totals.`,
    rules: [
      "Accept only per-share values with explicit wording like 'per aktie', 'kr/aktie', or 'per share'",
      "Reject company-level EPRA NRV / substansvärde totals that do not explicitly say per share",
      "If the source fragment lacks a per-share indicator, return value=null and source=null",
    ],
  },
  epra_nav: {
    key: "epra_nav",
    group: "epra_nrv",
    unit: "sek",
    keywords: ["Långsiktigt substansvärde", "Substansvärde", "Net asset value", "NAV"],
    description: `Total (company-level) NAV — NOT per share. Must NOT contain "EPRA", "NRV", "per aktie", "per share".`,
    optional: true,
  },
  equity: {
    key: "equity",
    group: "epra_nrv",
    unit: "sek",
    keywords: ["Eget kapital", "Equity", "Totalt eget kapital", "Total equity", "Shareholders' equity"],
    description: "Balance-sheet equity. Normalize mkr/MSEK to SEK.",
    optional: true,
  },
  pref_equity: {
    key: "pref_equity",
    group: "epra_nrv",
    unit: "sek",
    keywords: ["Preferensaktier", "Preference shares", "Preferenskapital", "Hybrid capital", "Hybridinstrument"],
    description: "Preference / hybrid equity on balance sheet. Normalize mkr/MSEK to SEK.",
    optional: true,
  },
  derivatives_balance_sheet: {
    key: "derivatives_balance_sheet",
    group: "epra_nrv",
    unit: "sek",
    keywords: ["Derivat, verkligt värde", "Derivatives, fair value", "Derivat", "Derivatives"],
    description: "Derivatives at fair value on balance sheet. Normalize mkr/MSEK to SEK.",
    optional: true,
  },
  deferred_tax_balance_sheet: {
    key: "deferred_tax_balance_sheet",
    group: "epra_nrv",
    unit: "sek",
    keywords: ["Uppskjuten skatt", "Deferred tax", "Skatteskuld", "Tax liability"],
    description: "Deferred tax on balance sheet. Normalize mkr/MSEK to SEK.",
    optional: true,
  },
  number_of_shares: {
    key: "number_of_shares",
    group: "epra_nrv",
    unit: "shares",
    keywords: [
      "stamaktier", "ordinary shares", "common shares", "outstanding shares",
      "Antal aktier", "Number of shares", "aktier vid periodens slut",
    ],
    description: "Total outstanding ordinary shares at period end. Return RAW number; source MUST include any unit indicator (tusental, thousands). Exclude preference/hybrid/diluted shares.",
    optional: true,
  },

  // ─── Property Value ──────────────────────────────────────────────────────────
  property_market_value: {
    key: "property_market_value",
    group: "property_value",
    unit: "sek",
    keywords: [
      "Marknadsvärde på fastigheter", "Marknadsvärde fastigheter", "Fastighetsvärde",
      "Market value of properties", "Property market value", "Fair value of properties",
    ],
    description: "Market value of investment properties. Total portfolio, NOT per-share. Normalize mkr/MSEK to SEK.",
  },
  property_value_change_quarter: {
    key: "property_value_change_quarter",
    group: "property_value",
    unit: "sek",
    keywords: [
      "Värdeförändring på fastigheter", "Värdeförändring fastigheter",
      "Orealiserade värdeförändringar", "Change in value of properties",
    ],
    description: "Change in value of properties for the quarter (SEK). Can be negative. Normalize mkr/MSEK.",
    optional: true,
  },
  avg_yield_requirement: {
    key: "avg_yield_requirement",
    group: "property_value",
    unit: "percent",
    keywords: [
      "Genomsnittligt avkastningskrav", "Avkastningskrav", "Direktavkastningskrav",
      "Average yield requirement", "Cap rate", "Capitalisation rate",
    ],
    description: "Average yield requirement / cap rate (percent). Return number without % sign.",
    optional: true,
  },

  // ─── Area ────────────────────────────────────────────────────────────────────
  lettable_area_sqm: {
    key: "lettable_area_sqm",
    group: "area_metrics",
    unit: "sqm",
    keywords: ["Uthyrbar area", "Uthyrbar yta", "Uthyrningsbar area", "Lettable area", "Leasable area"],
    description: `Total lettable area in sqm. "tkvm" means thousands of sqm — multiply by 1,000.`,
  },

  // ─── Rental Performance ──────────────────────────────────────────────────────
  economic_occupancy_rate: {
    key: "economic_occupancy_rate",
    group: "rental_performance",
    unit: "percent",
    keywords: ["Ekonomisk uthyrningsgrad", "Uthyrningsgrad", "Economic occupancy rate", "Occupancy rate"],
    description: "Economic occupancy rate (percent). Return number without % sign.",
  },
  rental_income_quarter: {
    key: "rental_income_quarter",
    group: "rental_performance",
    unit: "sek",
    keywords: ["Hyresintäkter", "Hyresintäkt", "Rental income", "Rental revenue"],
    description: "Rental income for the quarter (SEK). Normalize mkr/MSEK to SEK.",
    optional: true,
  },
  surplus_ratio: {
    key: "surplus_ratio",
    group: "rental_performance",
    unit: "percent",
    keywords: ["Överskottsgrad", "Surplus ratio", "Net operating income margin"],
    description: "Surplus ratio / NOI margin (percent). Return number without % sign.",
    optional: true,
  },

  // ─── Lease Profile ───────────────────────────────────────────────────────────
  avg_remaining_lease_term_years: {
    key: "avg_remaining_lease_term_years",
    group: "lease_profile",
    unit: "years",
    keywords: [
      "Genomsnittlig återstående hyrestid", "Återstående kontraktstid",
      "Average remaining lease term", "WAULT",
    ],
    description: "Average remaining lease term in years.",
  },

  // ─── Financing Risk ──────────────────────────────────────────────────────────
  loan_to_value: {
    key: "loan_to_value",
    group: "financing_risk",
    unit: "percent",
    keywords: ["Belåningsgrad", "Loan-to-value", "LTV"],
    description: "Loan-to-value ratio (percent). Return number without % sign.",
  },
  interest_coverage_ratio: {
    key: "interest_coverage_ratio",
    group: "financing_risk",
    unit: "ratio",
    keywords: ["Räntetäckningsgrad", "Interest coverage ratio", "ICR"],
    description: `Interest coverage ratio (multiple). Return number without "x" or "ggr".`,
    optional: true,
  },
  interest_fixation_years: {
    key: "interest_fixation_years",
    group: "financing_risk",
    unit: "years",
    keywords: ["Räntebindning", "Genomsnittlig räntebindning", "Interest rate commitment", "Fixed interest period"],
    description: "Average interest rate commitment in years.",
    optional: true,
  },
  capital_fixation_years: {
    key: "capital_fixation_years",
    group: "financing_risk",
    unit: "years",
    keywords: ["Kapitalbindning", "Genomsnittlig kapitalbindning", "Capital commitment"],
    description: "Average capital commitment in years.",
    optional: true,
  },
};

export function getMetricsByGroup(groupKey: string): MetricDef[] {
  return Object.values(METRICS).filter((m) => m.group === groupKey);
}
