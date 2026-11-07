import { MODELS, type Env } from "./types";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Workers AI model typings lag behind the catalog, so calls go through this
// loosely-typed shim.
function ai(env: Env): { run(model: string, input: unknown): Promise<any> } {
  return env.AI as any;
}

export function chatModel(env: Env): string {
  return env.CHAT_MODEL || MODELS.chat;
}

export async function runChat(
  env: Env,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const res = await ai(env).run(chatModel(env), {
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.4,
  });
  const text =
    typeof res === "string"
      ? res
      : (res?.response ?? res?.output_text ?? res?.output?.[0]?.content?.[0]?.text ?? "");
  return String(text).trim();
}

/** Embeds texts with bge-base (768 dims). Batches to stay within model limits. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50);
    const res = await ai(env).run(MODELS.embed, { text: batch });
    out.push(...(res.data as number[][]));
  }
  return out;
}

export async function transcribe(env: Env, audio: ArrayBuffer): Promise<string> {
  const res = await ai(env).run(MODELS.stt, { audio: toBase64(audio) });
  return String(res?.text ?? "").trim();
}

/** Returns MP3 bytes for the given text. */
export async function speak(env: Env, text: string): Promise<Uint8Array> {
  const res = await ai(env).run(MODELS.tts, { prompt: text.slice(0, 2000), lang: "en" });
  if (res instanceof ReadableStream) {
    return new Uint8Array(await new Response(res).arrayBuffer());
  }
  return fromBase64(String(res.audio));
}

/** Splits text into overlapping chunks on paragraph/sentence boundaries. */
export function chunkText(text: string, size = 1200, overlap = 200): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
      if (cut > size * 0.5) end = start + cut + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
