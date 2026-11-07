import { DurableObject } from "cloudflare:workers";
import { cosine } from "./ai";
import type { ChatTurn, ChunkInput, Env, RetrievedChunk, RetrievedMemory } from "./types";

/**
 * SQLite-backed Durable Object that holds the navigator's knowledge base:
 * crawled/ingested documents, embedded chunks, chat history, and an adaptive
 * memory that learns from user feedback.
 *
 * Adaptive memory works in two ways:
 *  - every chunk carries a `weight` that thumbs up/down on answers that cited it
 *    nudges up or down, re-ranking future retrieval;
 *  - answers the user liked are stored as embedded Q/A "memories" and surfaced
 *    again when a similar question is asked.
 */
export class KnowledgeStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        crawl_id TEXT,
        url TEXT,
        title TEXT,
        summary TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
      CREATE TABLE IF NOT EXISTS crawls (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        pages INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        question TEXT,
        chunk_ids TEXT,
        rating INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        message_id TEXT UNIQUE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        embedding TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // ---------- documents ----------

  addDocument(doc: {
    url?: string | null;
    title?: string | null;
    summary?: string | null;
    crawlId?: string | null;
    chunks: ChunkInput[];
  }): { docId: string; chunks: number } {
    const docId = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      // Re-crawling the same URL replaces the old copy.
      if (doc.url) {
        for (const row of this.sql.exec<{ id: string }>("SELECT id FROM documents WHERE url = ?", doc.url).toArray()) {
          this.sql.exec("DELETE FROM chunks WHERE doc_id = ?", row.id);
          this.sql.exec("DELETE FROM documents WHERE id = ?", row.id);
        }
      }
      this.sql.exec(
        "INSERT INTO documents (id, crawl_id, url, title, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        docId, doc.crawlId ?? null, doc.url ?? null, doc.title ?? null, doc.summary ?? null, now,
      );
      doc.chunks.forEach((c, i) => {
        this.sql.exec(
          "INSERT INTO chunks (id, doc_id, ord, text, embedding) VALUES (?, ?, ?, ?, ?)",
          crypto.randomUUID(), docId, i, c.text, JSON.stringify(c.embedding),
        );
      });
    });
    return { docId, chunks: doc.chunks.length };
  }

  listDocuments(crawlId?: string) {
    const q = `SELECT d.id, d.crawl_id AS crawlId, d.url, d.title, d.summary, d.created_at AS createdAt,
                      (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks
               FROM documents d ${crawlId ? "WHERE d.crawl_id = ?" : ""}
               ORDER BY d.created_at DESC LIMIT 200`;
    return (crawlId ? this.sql.exec(q, crawlId) : this.sql.exec(q)).toArray();
  }

  deleteDocument(id: string): boolean {
    const exists = this.sql.exec("SELECT 1 FROM documents WHERE id = ?", id).toArray().length > 0;
    this.sql.exec("DELETE FROM chunks WHERE doc_id = ?", id);
    this.sql.exec("DELETE FROM documents WHERE id = ?", id);
    return exists;
  }

  stats() {
    const one = (q: string) => Number(this.sql.exec<{ n: number }>(q).one().n);
    return {
      documents: one("SELECT COUNT(*) AS n FROM documents"),
      chunks: one("SELECT COUNT(*) AS n FROM chunks"),
      memories: one("SELECT COUNT(*) AS n FROM memories"),
      crawls: one("SELECT COUNT(*) AS n FROM crawls"),
    };
  }

  // ---------- retrieval ----------

  /**
   * Brute-force cosine search over all chunks, re-ranked by learned feedback
   * weight. Fine for thousands of chunks; swap in Vectorize for larger corpora.
   */
  retrieve(queryEmbedding: number[], k = 5): { chunks: RetrievedChunk[]; memories: RetrievedMemory[] } {
    const scored: RetrievedChunk[] = [];
    const cursor = this.sql.exec<{
      id: string; doc_id: string; text: string; embedding: string; weight: number; url: string | null; title: string | null;
    }>(
      `SELECT c.id, c.doc_id, c.text, c.embedding, c.weight, d.url, d.title
       FROM chunks c JOIN documents d ON d.id = c.doc_id`,
    );
    for (const row of cursor) {
      const similarity = cosine(queryEmbedding, JSON.parse(row.embedding));
      const weight = Number(row.weight);
      scored.push({
        id: row.id, docId: row.doc_id, text: row.text, url: row.url, title: row.title,
        similarity, weight, score: similarity * (1 + weight),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const chunks = scored.slice(0, k).filter((c) => c.similarity > 0.45);

    const memories: RetrievedMemory[] = [];
    for (const row of this.sql.exec<{ id: string; question: string; answer: string; embedding: string }>(
      "SELECT id, question, answer, embedding FROM memories",
    )) {
      const similarity = cosine(queryEmbedding, JSON.parse(row.embedding));
      if (similarity > 0.8) memories.push({ id: row.id, question: row.question, answer: row.answer, similarity });
    }
    memories.sort((a, b) => b.similarity - a.similarity);

    return { chunks, memories: memories.slice(0, 2) };
  }

  // ---------- chat history ----------

  history(sessionId: string, limit = 10): ChatTurn[] {
    return this.sql
      .exec<{ role: "user" | "assistant"; content: string }>(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
        sessionId, limit,
      )
      .toArray()
      .reverse();
  }

  saveExchange(sessionId: string, question: string, answer: string, chunkIds: string[]): { messageId: string } {
    const now = Date.now();
    const messageId = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
      crypto.randomUUID(), sessionId, question, now,
    );
    this.sql.exec(
      "INSERT INTO messages (id, session_id, role, content, question, chunk_ids, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
      messageId, sessionId, answer, question, JSON.stringify(chunkIds), now + 1,
    );
    return { messageId };
  }

  clearHistory(sessionId: string): void {
    this.sql.exec("DELETE FROM messages WHERE session_id = ?", sessionId);
  }

  // ---------- feedback / adaptive memory ----------

  /**
   * Applies a thumbs up (+1) / down (-1) to an assistant message. The change is
   * relative to any previous rating so re-voting doesn't double count.
   * Returns the question text when a new memory should be embedded.
   */
  applyFeedback(messageId: string, rating: 1 | -1): { ok: boolean; rememberQuestion?: string; answer?: string } {
    const msg = this.sql
      .exec<{ chunk_ids: string | null; rating: number | null; question: string | null; content: string }>(
        "SELECT chunk_ids, rating, question, content FROM messages WHERE id = ? AND role = 'assistant'",
        messageId,
      )
      .toArray()[0];
    if (!msg) return { ok: false };

    const previous = msg.rating ?? 0;
    if (previous === rating) return { ok: true };

    const delta = (r: number) => (r > 0 ? 0.1 : r < 0 ? -0.15 : 0);
    const change = delta(rating) - delta(previous);
    const ids: string[] = msg.chunk_ids ? JSON.parse(msg.chunk_ids) : [];
    for (const id of ids) {
      this.sql.exec("UPDATE chunks SET weight = MIN(1.0, MAX(-0.5, weight + ?)) WHERE id = ?", change, id);
    }
    this.sql.exec("UPDATE messages SET rating = ? WHERE id = ?", rating, messageId);

    if (rating < 0) {
      this.sql.exec("DELETE FROM memories WHERE message_id = ?", messageId);
      return { ok: true };
    }
    return { ok: true, rememberQuestion: msg.question ?? undefined, answer: msg.content };
  }

  addMemory(messageId: string, question: string, answer: string, embedding: number[]): void {
    this.sql.exec(
      `INSERT INTO memories (id, message_id, question, answer, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO NOTHING`,
      crypto.randomUUID(), messageId, question, answer, JSON.stringify(embedding), Date.now(),
    );
  }

  listMemories() {
    return this.sql
      .exec("SELECT id, question, answer, created_at AS createdAt FROM memories ORDER BY created_at DESC LIMIT 100")
      .toArray();
  }

  deleteMemory(id: string): void {
    this.sql.exec("DELETE FROM memories WHERE id = ?", id);
  }

  // ---------- crawls ----------

  createCrawl(id: string, url: string): void {
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO crawls (id, url, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
      id, url, now, now,
    );
  }

  updateCrawl(id: string, patch: { status?: string; pages?: number; summary?: string; error?: string }): void {
    const cur = this.getCrawl(id);
    if (!cur) return;
    this.sql.exec(
      "UPDATE crawls SET status = ?, pages = ?, summary = ?, error = ?, updated_at = ? WHERE id = ?",
      patch.status ?? cur.status, patch.pages ?? cur.pages, patch.summary ?? cur.summary,
      patch.error ?? cur.error, Date.now(), id,
    );
  }

  getCrawl(id: string) {
    return this.sql
      .exec<{ id: string; url: string; status: string; pages: number; summary: string | null; error: string | null; createdAt: number; updatedAt: number }>(
        "SELECT id, url, status, pages, summary, error, created_at AS createdAt, updated_at AS updatedAt FROM crawls WHERE id = ?",
        id,
      )
      .toArray()[0] ?? null;
  }

  listCrawls() {
    return this.sql
      .exec("SELECT id, url, status, pages, summary, error, created_at AS createdAt FROM crawls ORDER BY created_at DESC LIMIT 50")
      .toArray();
  }
}

/** All requests share one global knowledge base instance. */
export function knowledge(env: Env): DurableObjectStub<KnowledgeStore> {
  return env.KNOWLEDGE.get(env.KNOWLEDGE.idFromName("global"));
}
