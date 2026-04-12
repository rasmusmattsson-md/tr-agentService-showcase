/**
 * reportsFinderCustom.ts
 *
 * Three-method cascade to locate a company financial report PDF:
 *   1. mfn.se navigation — structured Swedish IR press release hub, correct period guaranteed
 *   2. Website crawl     — model navigates the company's own site via fetch_page
 *   3. OpenAI web search — last resort using the Responses API with web_search_preview
 *
 * Returns: { report_url: string | null, method?: "mfn" | "crawl" | "openai_search" }
 */

import OpenAI from "openai";
import type { Logger } from "pino";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReportsFinderInput {
  name: string;
  website_url: string;
  /** ISO date (YYYY-MM-DD). The period type and year are inferred from this. */
  as_of_date: string;
  _note?: string;
}

export interface ReportsFinderOutput {
  report_url: string | null;
  method?: "mfn" | "crawl" | "openai_search";
}

type ReportsFinderMethod = NonNullable<ReportsFinderOutput["method"]>;

type PdfLink = {
  text: string;
  url: string;
};

interface PageResult {
  url: string;
  title: string;
  pdf_links: PdfLink[];
  page_links: Array<{ text: string; url: string }>;
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FETCHES = 8;
const MFN_HOSTNAME = "mfn.se";
const MFN_BASE = "https://mfn.se";

// ─── Shared utilities ─────────────────────────────────────────────────────────

/** Reject URLs whose path year is more than one year behind the target. */
function urlLooksTooOldForAsOfDate(reportUrl: string, asOfIso: string): boolean {
  let pathname = "";
  try { pathname = new URL(reportUrl).pathname; } catch { return false; }
  const targetYear = new Date(asOfIso.slice(0, 10)).getFullYear();
  if (!Number.isFinite(targetYear)) return false;
  const years = [...pathname.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length === 0) return false;
  return Math.max(...years) < targetYear - 1;
}

function isValidCandidate(url: string | null | undefined, input: ReportsFinderInput): boolean {
  if (!url) return false;
  if (!url.toLowerCase().includes(".pdf")) return false;
  if (input.as_of_date && urlLooksTooOldForAsOfDate(url, input.as_of_date)) return false;
  return true;
}

async function normalizeCandidateUrl(
  url: string | null | undefined,
  input: ReportsFinderInput,
  log?: Logger
): Promise<string | null> {
  if (!url) return null;

  if (isValidCandidate(url, input)) {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (url.toLowerCase().includes(".pdf")) {
    return isValidCandidate(url, input) ? url : null;
  }

  const page = await fetchPage(url, parsed.hostname);
  const preferredPdf = page.pdf_links.find((pdf) => {
    const text = pdf.text.toLowerCase();
    if (/press release|pressmeddelande/.test(text)) return false;
    return /interim report|financial report|delårsrapport|halvårsrapport|årsredovisning|report/.test(text);
  });
  const resolvedPdf = preferredPdf?.url
    ?? page.pdf_links.find((pdf) => isValidCandidate(pdf.url, input))?.url
    ?? null;

  if (resolvedPdf) {
    log?.info({
      event: "reports_finder.candidate.normalized_to_pdf",
      source_url: url,
      pdf_url: resolvedPdf,
    }, "reports_finder.candidate.normalized_to_pdf");
  }

  return resolvedPdf;
}

// ─── Page fetcher (shared by all crawl-based methods) ────────────────────────

function resolveUrl(href: string, base: string): string | null {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function extractLinks(html: string, pageUrl: string, allowedHostname: string): PageResult {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const pdfLinks: PdfLink[] = [];
  const seenPdfUrls = new Set<string>();
  const pageLinks: Array<{ text: string; url: string }> = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1].trim();
    const rawText = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved) continue;

    let parsed: URL;
    try { parsed = new URL(resolved); } catch { continue; }

    // For mfn.se: also collect PDF links from any domain (reports are often on S3/CDN)
    if (resolved.toLowerCase().includes(".pdf")) {
      if (!seenPdfUrls.has(resolved)) {
        seenPdfUrls.add(resolved);
        pdfLinks.push({ text: rawText.slice(0, 120), url: resolved });
      }
      continue;
    }

    if (parsed.hostname !== allowedHostname) continue;

    if (!seen.has(resolved) && pageLinks.length < 50) {
      seen.add(resolved);
      pageLinks.push({ text: rawText.slice(0, 120), url: resolved });
    }
  }

  return { url: pageUrl, title, pdf_links: pdfLinks, page_links: pageLinks };
}

async function fetchPage(url: string, allowedHostname: string): Promise<PageResult> {
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    return { url, title: "", pdf_links: [], page_links: [], error: "Invalid URL" };
  }

  if (parsed.hostname !== allowedHostname) {
    return { url, title: "", pdf_links: [], page_links: [], error: `Outside allowed domain (${allowedHostname})` };
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return { url, title: "", pdf_links: [], page_links: [], error: `HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      return { url, title: "PDF", pdf_links: [{ text: "PDF", url }], page_links: [] };
    }
    if (!contentType.includes("html")) {
      return { url, title: "", pdf_links: [], page_links: [], error: `Non-HTML content: ${contentType}` };
    }

    return extractLinks(await res.text(), url, allowedHostname);
  } catch (err) {
    return { url, title: "", pdf_links: [], page_links: [], error: String(err) };
  }
}

// ─── Method 1: mfn.se navigation ─────────────────────────────────────────────

/** Infer which report period a calendar date falls into (Swedish cumulative format). */
function inferPeriodFromAsOfDate(asOfDate: string): { year: number; type: "Q1" | "Q2" | "Q3" | "Q4" } {
  const date = new Date(asOfDate);
  const month = date.getMonth() + 1; // 1–12
  const year = date.getFullYear();
  if (month <= 3) return { year, type: "Q1" };
  if (month <= 6) return { year, type: "Q2" };
  if (month <= 9) return { year, type: "Q3" };
  return { year, type: "Q4" };
}

function buildMfnSystemPrompt(asOfDate: string): string {
  const { year, type } = inferPeriodFromAsOfDate(asOfDate);
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;
  const filter = `filter=(and(or(.properties.tags%40>%5B"sub%3Areport"%5D)))&from=${from}&to=${to}`;

  const targetDescriptions: Record<string, string> = {
    Q1: `Q1 ${year} interim report (delårsrapport jan–mar ${year})`,
    Q2: `Q2 ${year} half-year report (halvårsrapport jan–jun ${year})`,
    Q3: `Q3 ${year} interim report (delårsrapport jan–sep ${year})`,
    Q4: `Q4 ${year} year-end report (bokslutskommuniké ${year})`,
    annual: `annual report (årsredovisning) for fiscal year ${year}`,
    interim: `interim report for ${year}`,
  };

  return `
ROLE
You find direct PDF download links for Swedish listed company financial reports on mfn.se.

TOOL
fetch_page(url): Fetches a page on mfn.se and returns its links. ONLY mfn.se URLs allowed.

TARGET REPORT
${targetDescriptions[type] ?? `${type} ${year} report`}

HOW mfn.se IS STRUCTURED
- Company IR pages: ${MFN_BASE}/all/a/{company-slug}
- Filtered report pages: ${MFN_BASE}/all/a/{company-slug}?${filter}
- Each item on the IR page is a press release linking to: ${MFN_BASE}/a/{company-slug}/{release-id}
- Press release pages contain a direct PDF download link (often hosted on S3/CDN outside mfn.se)

STRATEGY
Step 1 — Find the company page:
  Derive the slug from the company name (lowercase, spaces → hyphens).
  Examples: "NP3" → "np3-fastigheter", "Fabege" → "fabege", "Atrium Ljungberg" → "atrium-ljungberg"
  Fetch the FILTERED report page first:
  ${MFN_BASE}/all/a/{slug}?${filter}
  If needed, try the unfiltered page:
  ${MFN_BASE}/all/a/{slug}
  If you get an error or empty page, try slug variations or fetch ${MFN_BASE}/search?q={name}

Step 2 — Find the right press release:
  Scan the page links for a title matching the TARGET REPORT (year + type).
  Pick the most recent matching one — NOT an older archive entry.

Step 3 — Get the PDF:
  Fetch the press release page.
  Look for a direct .pdf link in pdf_links or page_links.
  Prefer attachment text like "Interim Report", "Delårsrapport", "Half-year report", "Annual Report".
  Reject attachment text like "Press release" or "Pressmeddelande".
  Return that URL.

PERIOD MATCHING RULES
- Q1 report title will contain "Q1", "januari–mars", "jan-mar", or "delårsrapport" + year
- Q2/half-year: "Q2", "halvår", "januari–juni"
- Q3: "Q3", "januari–september", "nio månader"
- Annual: "årsredovisning", "annual report" + year
- Year-end: "bokslutskommuniké" + year
- Match year EXACTLY. Do NOT accept a ${year - 1} or ${year - 2} report for a ${year} request.

HARD RULES
- Only fetch URLs on ${MFN_HOSTNAME}.
- Max ${MAX_FETCHES} fetch calls total.
- Return a direct .pdf URL — never an HTML page URL.
- Never return a PDF attachment whose visible link text is "Press release" or "Pressmeddelande" when another report attachment is available.

OUTPUT (JSON only, no commentary)
{ "report_url": "<direct .pdf url>" }  OR  { "report_url": null }
`.trim();
}

async function findViaMfn(input: ReportsFinderInput, log?: Logger): Promise<ReportsFinderOutput> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildMfnSystemPrompt(input.as_of_date) },
    {
      role: "user",
      content: JSON.stringify({
        name: input.name,
        as_of_date: input.as_of_date,
        ...(input._note ? { _note: input._note } : {}),
      }),
    },
  ];

  let fetchCount = 0;

  while (true) {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      tools: [
        {
          type: "function",
          function: {
            name: "fetch_page",
            description: "Fetch a page on mfn.se and return its links and PDF links.",
            parameters: {
              type: "object",
              properties: {
                url: { type: "string", description: `URL to fetch. Must be on ${MFN_HOSTNAME}.` },
              },
              required: ["url"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
      messages,
    });

    const choice = response.choices[0];
    if (!choice) break;

    const { message } = choice;
    messages.push(message);

    if (choice.finish_reason === "tool_calls" && message.tool_calls?.length) {
      if (fetchCount >= MAX_FETCHES) {
        messages.push(
          ...message.tool_calls.map((call) => ({
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify({ error: "Fetch limit reached." }),
          }))
        );
        messages.push({ role: "user", content: "Fetch limit reached. Return your best result as JSON now." });
        continue;
      }

      const results = await Promise.all(
        message.tool_calls.map(async (call) => {
          const args = JSON.parse((call as any).function.arguments) as { url: string };
          fetchCount++;
          log?.info({ event: "reports_finder.mfn.fetch", url: args.url, fetch_number: fetchCount }, "reports_finder.mfn.fetch");
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify(await fetchPage(args.url, MFN_HOSTNAME)),
          };
        })
      );

      messages.push(...results);
      continue;
    }

    // Model is done — parse final answer
    try {
      const parsed = JSON.parse(message.content ?? "{}") as { report_url?: string | null };
      const url = await normalizeCandidateUrl(parsed.report_url ?? null, input, log);
      if (isValidCandidate(url, input)) {
        log?.info({ event: "reports_finder.mfn.found", url, fetches: fetchCount }, "reports_finder.mfn.found");
        return { report_url: url, method: "mfn" };
      }
    } catch { /* fall through */ }

    log?.info({ event: "reports_finder.mfn.no_result", fetches: fetchCount }, "reports_finder.mfn.no_result");
    return { report_url: null };
  }

  return { report_url: null };
}

// ─── Method 2: Company website crawl ─────────────────────────────────────────

function buildCrawlSystemPrompt(allowedHostname: string, asOfDate?: string | null): string {
  const targetBlock = asOfDate?.trim()
    ? `
TARGET PERIOD
- Needed for calendar date: **${asOfDate.slice(0, 10)}** — infer the reporting quarter/year from this.
- Return only the PDF covering that specific period. Do NOT return archive PDFs from earlier years.
`
    : "";

  return `
ROLE
Deterministic PDF locator for Swedish listed real estate companies.
Find the direct PDF URL of a specific financial report on the company's own website.

TOOL
fetch_page(url): Fetches a page and returns its links. Only URLs on ${allowedHostname} are allowed.
${targetBlock}
STRATEGY
1. Fetch website_url → find investor relations or financial reports section.
2. Follow links containing "investor", "investerare", "rapporter", "financial reports".
3. On the reports page, find the link matching the requested report type and year.
4. If a matching link leads to HTML (not PDF), fetch it to find the direct .pdf link.
5. Return the direct PDF URL.

PERIOD DEFINITIONS (Swedish cumulative format)
Q1: ends March · Q2: ends June · Q3: ends September · Q4/Annual: ends December

HARD RULES
- Return .pdf URLs only — never HTML page URLs.
- Max ${MAX_FETCHES} fetch calls total.

OUTPUT (JSON only, no commentary)
{ "report_url": "<direct .pdf url>" }  OR  { "report_url": null }
`.trim();
}

async function findViaCrawl(input: ReportsFinderInput, log?: Logger): Promise<ReportsFinderOutput> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let allowedHostname: string;
  try { allowedHostname = new URL(input.website_url).hostname; } catch {
    return { report_url: null };
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildCrawlSystemPrompt(allowedHostname, input.as_of_date) },
    { role: "user", content: JSON.stringify(input) },
  ];

  let fetchCount = 0;

  while (true) {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      tools: [
        {
          type: "function",
          function: {
            name: "fetch_page",
            description: "Fetch a page from the company website and return its links.",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
              required: ["url"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
      messages,
    });

    const choice = response.choices[0];
    if (!choice) break;

    const { message } = choice;
    messages.push(message);

    if (choice.finish_reason === "tool_calls" && message.tool_calls?.length) {
      if (fetchCount >= MAX_FETCHES) {
        messages.push(
          ...message.tool_calls.map((call) => ({
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify({ error: "Fetch limit reached." }),
          }))
        );
        messages.push({ role: "user", content: "Fetch limit reached. Return your best result as JSON now." });
        continue;
      }

      const results = await Promise.all(
        message.tool_calls.map(async (call) => {
          const args = JSON.parse((call as any).function.arguments) as { url: string };
          fetchCount++;
          log?.info({ event: "reports_finder.crawl.fetch", url: args.url, fetch_number: fetchCount }, "reports_finder.crawl.fetch");
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify(await fetchPage(args.url, allowedHostname)),
          };
        })
      );

      messages.push(...results);
      continue;
    }

    try {
      const parsed = JSON.parse(message.content ?? "{}") as { report_url?: string | null };
      const url = await normalizeCandidateUrl(parsed.report_url ?? null, input, log);
      if (isValidCandidate(url, input)) {
        log?.info({ event: "reports_finder.crawl.found", url, fetches: fetchCount }, "reports_finder.crawl.found");
        return { report_url: url, method: "crawl" };
      }
    } catch { /* fall through */ }

    log?.info({ event: "reports_finder.crawl.no_result", fetches: fetchCount }, "reports_finder.crawl.no_result");
    return { report_url: null };
  }

  return { report_url: null };
}

// ─── Method 3: OpenAI web search ──────────────────────────────────────────────

async function findViaOpenAISearch(input: ReportsFinderInput, log?: Logger): Promise<ReportsFinderOutput> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const { year, type } = inferPeriodFromAsOfDate(input.as_of_date);
  const query = `"${input.name}" ${year} ${type} report årsredovisning filetype:pdf`;

  log?.info({ event: "reports_finder.openai_search.searching", query }, "reports_finder.openai_search.searching");

  try {
    const response = await (client as any).responses.create({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search_preview" }],
      input: `${query}\n\nFind the direct PDF download URL. Return ONLY JSON: { "report_url": "<url>" } or { "report_url": null } if not found.`,
    });

    const text: string = response.output_text ?? "";

    const jsonMatch = text.match(/\{[^{}]*"report_url"[^{}]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { report_url?: string | null };
      const url = await normalizeCandidateUrl(parsed.report_url ?? null, input, log);
      if (isValidCandidate(url, input)) {
        log?.info({ event: "reports_finder.openai_search.found", url }, "reports_finder.openai_search.found");
        return { report_url: url, method: "openai_search" };
      }
    }

    const urlMatch = text.match(/https?:\/\/[^\s"'<>]+\.pdf/i);
    if (urlMatch && isValidCandidate(urlMatch[0], input)) {
      return { report_url: urlMatch[0], method: "openai_search" };
    }
  } catch (err) {
    log?.warn({ event: "reports_finder.openai_search.failed", error: String(err) }, "reports_finder.openai_search.failed");
  }

  return { report_url: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function findReport(
  input: ReportsFinderInput,
  options?: { logger?: Logger; skipMethods?: ReportsFinderMethod[] }
): Promise<ReportsFinderOutput> {
  const log = options?.logger;
  const skipMethods = new Set(options?.skipMethods ?? []);
  log?.info({ event: "reports_finder.start", name: input.name, website: input.website_url }, "reports_finder.start");

  // Method 1: mfn.se — structured Swedish IR hub, period-accurate
  if (!skipMethods.has("mfn")) {
    const mfnResult = await findViaMfn(input, log);
    if (mfnResult.report_url) return mfnResult;
  }

  // Method 2: Company website crawl
  if (!skipMethods.has("crawl")) {
    const crawlResult = await findViaCrawl(input, log);
    if (crawlResult.report_url) return crawlResult;
  }

  // Method 3: OpenAI web search (last resort)
  if (!skipMethods.has("openai_search")) {
    const aiResult = await findViaOpenAISearch(input, log);
    if (aiResult.report_url) return aiResult;
  }

  log?.warn({ event: "reports_finder.all_methods_failed", name: input.name }, "reports_finder.all_methods_failed");
  return { report_url: null };
}
