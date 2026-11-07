/// <reference types="@cloudflare/workers-types" />
import { chunkText, embed, runChat, speak, transcribe } from "./ai";
import { knowledge } from "./knowledge";
import { PROMPTS } from "./prompts";
import type { Env } from "./types";

export { KnowledgeStore } from "./knowledge";
export { CrawlWorkflow } from "./crawl";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

const fail = (message: string, status = 400) => json({ status: "error", message }, status);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (!pathname.startsWith("/api/")) {
      // Static UI is served by Workers Assets; anything else falls through here.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Edge Navigator Worker running");
    }

    try {
      const store = knowledge(env);

      // ---- chat (RAG + adaptive memory) ----
      if (pathname === "/api/chat") {
        let message: string;
        let sessionId: string;
        if (method === "GET") {
          message = url.searchParams.get("q") ?? "Say hello from the edge!";
          sessionId = url.searchParams.get("session") ?? "anonymous";
        } else if (method === "POST") {
          const b = await body<{ message?: string; sessionId?: string }>(request);
          message = (b.message ?? "").trim();
          sessionId = b.sessionId || "anonymous";
        } else return fail("Method not allowed", 405);
        if (!message) return fail("`message` is required");
        if (message.length > 4000) return fail("Message too long (max 4000 chars)");
        return json(await chat(env, sessionId, message));
      }

      if (pathname === "/api/history" && method === "GET") {
        return json({ status: "ok", messages: await store.history(url.searchParams.get("session") ?? "anonymous", 50) });
      }
      if (pathname === "/api/history" && method === "DELETE") {
        await store.clearHistory(url.searchParams.get("session") ?? "anonymous");
        return json({ status: "ok" });
      }

      // ---- feedback ----
      if (pathname === "/api/feedback" && method === "POST") {
        const { messageId, rating } = await body<{ messageId?: string; rating?: number }>(request);
        if (!messageId || (rating !== 1 && rating !== -1)) return fail("`messageId` and `rating` (1 or -1) are required");
        const res = await store.applyFeedback(messageId, rating);
        if (!res.ok) return fail("Unknown message", 404);
        if (res.rememberQuestion && res.answer) {
          const { rememberQuestion: q, answer: a } = res;
          ctx.waitUntil(embed(env, [q]).then(([v]) => store.addMemory(messageId, q, a, v)));
        }
        return json({ status: "ok" });
      }

      if (pathname === "/api/memories" && method === "GET") {
        return json({ status: "ok", memories: await store.listMemories() });
      }
      if (pathname.startsWith("/api/memories/") && method === "DELETE") {
        await store.deleteMemory(decodeURIComponent(pathname.slice("/api/memories/".length)));
        return json({ status: "ok" });
      }

      // ---- ingest raw text ----
      if (pathname === "/api/ingest" && method === "POST") {
        const b = await body<{ text?: string; title?: string; url?: string }>(request);
        const text = (b.text ?? "").trim();
        if (text.length < 20) return fail("`text` must be at least 20 characters");
        const chunks = chunkText(text.slice(0, 200_000)).slice(0, 100);
        const [vectors, summary] = await Promise.all([
          embed(env, chunks),
          runChat(env, [
            { role: "system", content: PROMPTS.pageSummary },
            { role: "user", content: text.slice(0, 12_000) },
          ], { maxTokens: 300, temperature: 0.2 }),
        ]);
        const res = await store.addDocument({
          title: b.title || text.slice(0, 60),
          url: b.url || null,
          summary,
          chunks: chunks.map((t, i) => ({ text: t, embedding: vectors[i] })),
        });
        return json({ status: "ok", ...res, summary });
      }

      // ---- semantic search only ----
      if (pathname === "/api/query" && method === "POST") {
        const { query, k } = await body<{ query?: string; k?: number }>(request);
        if (!query) return fail("`query` is required");
        const [v] = await embed(env, [query]);
        const res = await store.retrieve(v, Math.min(Math.max(k ?? 5, 1), 20));
        return json({ status: "ok", ...res });
      }

      // ---- crawl workflow ----
      if (pathname === "/api/crawl" && method === "POST") {
        const b = await body<{ url?: string; maxPages?: number }>(request);
        let target: URL;
        try {
          target = new URL(b.url ?? "");
          if (!/^https?:$/.test(target.protocol)) throw new Error();
        } catch {
          return fail("`url` must be a valid http(s) URL");
        }
        const cap = Number(env.MAX_CRAWL_PAGES ?? 10);
        const maxPages = Math.min(Math.max(Math.floor(b.maxPages ?? 5), 1), cap);
        const crawlId = crypto.randomUUID();
        await store.createCrawl(crawlId, target.toString());
        await env.CRAWL_WORKFLOW.create({ id: crawlId, params: { crawlId, url: target.toString(), maxPages } });
        return json({ status: "ok", crawlId, maxPages }, 202);
      }
      if (pathname === "/api/crawl" && method === "GET") {
        return json({ status: "ok", crawls: await store.listCrawls() });
      }
      if (pathname.startsWith("/api/crawl/") && method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/crawl/".length));
        const crawl = await store.getCrawl(id);
        if (!crawl) return fail("Unknown crawl", 404);
        let workflow: unknown = null;
        try {
          workflow = await (await env.CRAWL_WORKFLOW.get(id)).status();
        } catch { /* instance may not be visible yet */ }
        return json({ status: "ok", crawl, workflow, documents: await store.listDocuments(id) });
      }

      // ---- documents ----
      if (pathname === "/api/documents" && method === "GET") {
        return json({ status: "ok", documents: await store.listDocuments(), stats: await store.stats() });
      }
      if (pathname.startsWith("/api/documents/") && method === "DELETE") {
        const ok = await store.deleteDocument(decodeURIComponent(pathname.slice("/api/documents/".length)));
        return ok ? json({ status: "ok" }) : fail("Unknown document", 404);
      }

      // ---- voice ----
      if (pathname === "/api/voice/transcribe" && method === "POST") {
        const audio = await request.arrayBuffer();
        if (audio.byteLength === 0) return fail("Empty audio body");
        if (audio.byteLength > 10 * 1024 * 1024) return fail("Audio too large (max 10MB)", 413);
        return json({ status: "ok", text: await transcribe(env, audio) });
      }
      if (pathname === "/api/voice/speak" && method === "POST") {
        const { text } = await body<{ text?: string }>(request);
        if (!text) return fail("`text` is required");
        const mp3 = await speak(env, stripMarkdown(text));
        return new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
      }

      return fail("Not found", 404);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.message, err.status);
      console.error("API error:", err);
      return fail(String(err instanceof Error ? err.message : err), 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function chat(env: Env, sessionId: string, message: string) {
  const store = knowledge(env);
  const [[queryVec], history] = await Promise.all([embed(env, [message]), store.history(sessionId, 8)]);
  const { chunks, memories } = await store.retrieve(queryVec, 5);

  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.title ?? "Untitled"}${c.url ? ` (${c.url})` : ""}\n${c.text}`)
    .join("\n\n");
  const memoryText = memories.map((m) => `Q: ${m.question}\nA: ${m.answer}`).join("\n\n");

  const reply = await runChat(env, [
    { role: "system", content: PROMPTS.chat(context, memoryText) },
    ...history,
    { role: "user", content: message },
  ]);

  const { messageId } = await store.saveExchange(sessionId, message, reply, chunks.map((c) => c.id));
  return {
    status: "ok",
    model_reply: reply,
    messageId,
    sources: chunks.map((c, i) => ({
      n: i + 1, docId: c.docId, title: c.title, url: c.url,
      similarity: round(c.similarity), weight: round(c.weight), snippet: c.text.slice(0, 240),
    })),
    memoriesUsed: memories.length,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function stripMarkdown(s: string): string {
  return s.replace(/\[\d+\]/g, "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
}
