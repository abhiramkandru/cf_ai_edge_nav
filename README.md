# cf_ai_edge_nav — Cloudflare AI Edge Navigator

An AI-powered knowledge navigator and web summarizer that runs entirely on the Cloudflare Developer Platform. It crawls websites, summarizes them with **Llama 3.3 on Workers AI**, stores embeddings in a **SQLite-backed Durable Object**, and answers questions over that knowledge with retrieval-augmented chat. Answers you rate 👍/👎 change how future answers are retrieved and written. It includes a chat and voice UI served from the edge.

## Features

- **Crawl and summarize websites.** A durable **Workflow** fetches a site, discovers same-origin links, extracts readable text with `HTMLRewriter`, summarizes each page with Llama 3.3, embeds it, and writes a site-level overview. Each page runs as its own retryable step.
- **Contextual retrieval (RAG).** Questions are embedded with `bge-base-en-v1.5` and matched by cosine similarity against chunks stored in the Durable Object's SQLite database. The top matches go into the prompt, and the answer cites them as `[1]`, `[2]`, and so on.
- **Adaptive memory from feedback.**
  - Each chunk has a learned `weight`. A 👍 on an answer raises the weight of the chunks it cited and a 👎 lowers it, so retrieval is re-ranked by `similarity × (1 + weight)`.
  - Answers rated 👍 are saved as embedded Q/A *memories* and reused when a similar question comes up. A 👎 removes the memory.
- **Conversation memory.** Per-session chat history is kept in the Durable Object.
- **Voice.** Speech-to-text with Whisper (`whisper-large-v3-turbo`) and text-to-speech with MeloTTS, both on Workers AI. If TTS is unavailable, the UI falls back to the browser's speech synthesis.
- **Web UI.** A single-page chat, crawl and library interface served by Workers Static Assets.

## Architecture

```
Browser UI (public/)  ──►  Worker router (src/index.ts)
   chat · voice · crawl         │
                                ├─► Workers AI   Llama 3.3 70B (chat, summaries)
                                │                bge-base-en-v1.5 (embeddings)
                                │                Whisper (STT) · MeloTTS (TTS)
                                │
                                ├─► KnowledgeStore Durable Object (SQLite)
                                │     documents · chunks(+weights) · messages
                                │     memories · crawls
                                │
                                └─► CrawlWorkflow (Workflows)
                                      discover → per-page: fetch/extract →
                                      summarize → chunk/embed → store →
                                      site summary
```

| Component | Role |
| --- | --- |
| Workers | API router and static asset host |
| Workers AI (`env.AI`) | LLM, embeddings, speech-to-text and text-to-speech |
| Durable Objects + SQLite (`env.KNOWLEDGE`) | Knowledge base, vector search, chat history and feedback memory |
| Workflows (`env.CRAWL_WORKFLOW`) | Durable crawl and summarize pipeline with per-step retries |
| Static Assets (`env.ASSETS`) | Chat and voice UI |

## Project structure

```
cf_ai_edge_nav/
├── public/              # UI: index.html, app.js, styles.css
├── src/
│   ├── index.ts         # API router; exports the DO and the Workflow
│   ├── knowledge.ts     # KnowledgeStore Durable Object (SQLite)
│   ├── crawl.ts         # CrawlWorkflow
│   ├── extract.ts       # HTMLRewriter text + link extraction
│   ├── ai.ts            # Workers AI helpers, chunking, cosine similarity
│   ├── prompts.ts       # Prompt templates
│   └── types.ts         # Env + shared types, model IDs
├── wrangler.toml
├── PROMPTS.md
└── README.md
```

## API

| Method | Path | Body / query | Description |
| --- | --- | --- | --- |
| `POST` | `/api/chat` | `{ message, sessionId }` | RAG chat. Returns `model_reply`, `messageId` and `sources` |
| `GET` | `/api/chat?q=...&session=...` | | Same as above, convenient from a browser |
| `POST` | `/api/feedback` | `{ messageId, rating: 1 \| -1 }` | Rate an answer, which updates weights and memories |
| `GET` / `DELETE` | `/api/history?session=...` | | Read or clear a session's conversation |
| `POST` | `/api/crawl` | `{ url, maxPages? }` | Start a crawl Workflow. Returns `crawlId` |
| `GET` | `/api/crawl` | | List crawls |
| `GET` | `/api/crawl/:id` | | Crawl status, Workflow status and summarized pages |
| `POST` | `/api/ingest` | `{ text, title?, url? }` | Add raw text to the knowledge base |
| `POST` | `/api/query` | `{ query, k? }` | Semantic search only, with no LLM call |
| `GET` | `/api/documents` | | Documents and stats |
| `DELETE` | `/api/documents/:id` | | Remove a document |
| `GET` | `/api/memories` | | Learned Q/A memories |
| `DELETE` | `/api/memories/:id` | | Forget a memory |
| `POST` | `/api/voice/transcribe` | raw audio bytes | Speech to text |
| `POST` | `/api/voice/speak` | `{ text }` | Text to speech; returns `audio/mpeg` |

Example:

```bash
curl -X POST https://<your-worker>.workers.dev/api/crawl \
  -H "Content-Type: application/json" \
  -d '{"url":"https://developers.cloudflare.com/workflows/","maxPages":5}'

curl -X POST https://<your-worker>.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"How do Workflows retry failed steps?","sessionId":"demo"}'
```

```json
{
  "status": "ok",
  "model_reply": "Each step can be configured with a retry limit, delay and backoff... [1]",
  "messageId": "6c1f...",
  "sources": [{ "n": 1, "title": "Workflows · Cloudflare", "url": "https://...", "similarity": 0.81, "weight": 0.1 }],
  "memoriesUsed": 0
}
```

## Running it

Requirements: a Cloudflare account with Workers AI, Node 18 or later.

```bash
npm install
npx wrangler login
npm run dev        # http://localhost:8787
```

Workers AI always runs remotely, so `wrangler dev` needs you to be logged in, even for local development. The Durable Object and the Workflow run locally.

Deploy:

```bash
npm run deploy
```

This creates the Worker, the Durable Object (via the `v1` SQLite migration), the Workflow and the static assets in one step. Open the `workers.dev` URL that it prints to use the UI.

Configuration (`wrangler.toml` → `[vars]`):

- `CHAT_MODEL`: defaults to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `MAX_CRAWL_PAGES`: the server-side cap on pages per crawl (default `10`)

## Design notes

- **Vector search lives in the Durable Object.** Embeddings are stored in SQLite and compared by brute-force cosine similarity. This keeps retrieval, feedback weights and memories in one transactional store, and works well up to thousands of chunks. For larger corpora, the `retrieve()` method can be backed by Vectorize instead.
- **One global knowledge base.** All users share a single `KnowledgeStore` instance named `global`. Chat history is separated by `sessionId`, which the UI keeps in `localStorage`. For multi-tenant use, key the Durable Object by user or workspace.
- **Crawling is polite and bounded.** It fetches same-origin pages only, skips non-HTML assets, keeps at most 40 chunks per page and has a page cap. Re-crawling a URL replaces its previous copy.
- **The feedback math.** A 👍 adds `+0.1` to each cited chunk's weight and a 👎 adds `−0.15`. Weights are clamped to `[−0.5, 1.0]`. Changing your vote reverses the previous adjustment, so re-voting doesn't count twice.

## Author

Abhiram Kandru · https://abhiramkandru.com
