# agent-service

Core agent pipeline for the Trappan competitor intelligence system. Exposes a single internal HTTP endpoint consumed by `brain`.

## What it does

1. **Cache check** — returns cached metrics if fresh enough, skipping the pipeline
2. **Report discovery** — locates the correct quarterly PDF via a 3-method cascade (mfn.se → company website crawl → OpenAI web search)
3. **Term resolution (RAG)** — extracts definition blocks from the PDF, embeds them, and searches pgvector to map company-specific labels to canonical metric keys
4. **Extraction** — Tier 1: vision LLM on keyword-matched pages; Tier 2: web search fallback if confidence is insufficient
5. **Persist** — writes metrics, run log, and artifact record to Supabase

## Endpoints

```
POST /internal/competitor-intel/run
```

Called by brain. Body mirrors `brain`'s `POST /v1/competitor-intel` schema. Not intended to be called directly in production.

## Setup

```bash
cp .env.local.example .env.local  # fill in values below
npm install
npm run dev     # tsx watch, port 3002
```

```bash
npm run build   # tsc → dist/
npm start       # node dist/src/index.js
npm test        # vitest (unit tests, no network)
```

## Environment variables

```env
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# OpenAI
OPENAI_API_KEY=

# Langfuse (optional — traces are skipped if unset)
LANGFUSE_SECRET_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_BASE_URL=

# Logging (Better Stack — optional)
BETTER_STACK_ENDPOINT=
BETTER_STACK_SOURCE_TOKEN=

# Model overrides (defaults shown)
FIN_EXTRACT_MODEL=gpt-4o-mini          # Tier 1
FIN_EXTRACT_STRONG_MODEL=gpt-4o        # Tier 2 fallback
FIN_EXTRACT_DEFINITION_MODEL=gpt-4o-mini
FIN_EXTRACT_EMBEDDING_MODEL=text-embedding-3-small
FIN_DEFINITION_MATCH_THRESHOLD=0.78    # pgvector similarity cutoff

PORT=3002
```

## Architecture

```
orchestrator.ts          4-phase pipeline; threads TraceCtx through every call
├── reportsFinder.ts     3-method cascade to find the PDF URL
│   ├── findViaMfn()     LLM agent navigating mfn.se with fetch_page tool
│   ├── findViaCrawl()   LLM agent crawling the company's own IR page
│   └── findViaOpenAISearch()
├── parser/
│   ├── definitions.ts   RAG term resolution via pgvector
│   ├── tier1.ts         Keyword scan → render pages → vision LLM
│   └── tier2.ts         web_search_preview fallback
└── harness.ts           Generic retry wrapper with confidence-ranked best-result tracking
```

## Tests

```bash
npm test
```

Covers: retry harness, keyword search utilities & metric normalisation.