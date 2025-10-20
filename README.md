cf_ai_edge_nav — Cloudflare AI Edge Navigator

cf_ai_edge_nav is a serverless AI agent that runs entirely on the Cloudflare edge.
It combines Cloudflare Workers AI and Vectorize to deliver intelligent, low-latency responses without requiring any backend servers.

Overview

This project demonstrates a minimal Retrieval-Augmented Generation (RAG) pipeline running at the edge:

User → /api/chat → AI model (Llama)
User → /api/ingest → Embedding model → Vectorize storage

Core capabilities:

/api/chat prompts an AI model (Llama 3.1–8B) hosted on Cloudflare.

/api/ingest converts input text into embeddings and stores them in Vectorize.

/api/query (coming soon) will perform semantic search for context-aware chat.

This architecture enables globally distributed AI systems with no centralized servers.

Architecture
Component	Description
Cloudflare Workers	Executes the TypeScript worker logic globally.
Workers AI (env.AI)	Runs both text-generation and embedding models.
Vectorize (env.VECTOR_INDEX)	Stores and queries text embeddings for memory.
Wrangler CLI	Used to develop, test, and deploy the project.
Project Structure
cf_ai_edge_nav/
│
├── src/
│   ├── index.ts         # Main router for API endpoints
│   ├── ingest.ts        # Embedding + Vectorize write (coming soon)
│   ├── search.ts        # Semantic retrieval (coming soon)
│   └── types.ts         # Shared type definitions
│
├── wrangler.toml        # Worker configuration and bindings
├── package.json
├── PROMPTS.md           # Reference prompts or model templates
└── README.md

Bindings (wrangler.toml)
[ai]
binding = "AI"

[[vectorize]]
binding = "VECTOR_INDEX"
index_name = "edge-memory"

Local Development
npm install -g wrangler
wrangler dev


Then open:

http://localhost:8787


Try hitting:

http://localhost:8787/api/chat

Deploy to Cloudflare
wrangler deploy


Once deployed, your live API endpoint will be:

https://cf_ai_edge_nav.<your-account>.workers.dev/api/chat

Example (for this repository):

https://cf_ai_edge_nav.abhiramkandru123.workers.dev/api/chat

Example Response
{
  "status": "ok",
  "model_reply": "Hello from the edge! It's great to have you here."
}

Next Features (Planned)
Feature	Description	Status
/api/ingest	Store user-provided text embeddings into Vectorize	Planned
/api/query	Retrieve similar chunks to power contextual chat	Planned
Frontend UI	Simple web interface for interacting with the model	In Design
Requirements

Cloudflare Account

Wrangler CLI v4.43.0 or higher

Workers AI and Vectorize enabled on your account

Author

Abhiram Kandru
Cloudflare Edge AI Project, 2025
Website: https://abhiramkandru.com

Live API Test

Public test endpoint:

https://cf_ai_edge_nav.abhiramkandru123.workers.dev/api/chat