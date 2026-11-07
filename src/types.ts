import type { KnowledgeStore } from "./knowledge";

export interface Env {
  AI: Ai;
  KNOWLEDGE: DurableObjectNamespace<KnowledgeStore>;
  CRAWL_WORKFLOW: Workflow<CrawlParams>;
  ASSETS: Fetcher;
  CHAT_MODEL?: string;
  MAX_CRAWL_PAGES?: string;
}

export interface CrawlParams {
  crawlId: string;
  url: string;
  maxPages: number;
}

export interface ChunkInput {
  text: string;
  embedding: number[];
}

export interface RetrievedChunk {
  id: string;
  docId: string;
  text: string;
  url: string | null;
  title: string | null;
  similarity: number;
  weight: number;
  score: number;
}

export interface RetrievedMemory {
  id: string;
  question: string;
  answer: string;
  similarity: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export const MODELS = {
  chat: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  embed: "@cf/baai/bge-base-en-v1.5",
  stt: "@cf/openai/whisper-large-v3-turbo",
  tts: "@cf/myshell-ai/melotts",
} as const;
