import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { chunkText, embed, runChat } from "./ai";
import { fetchAndExtract } from "./extract";
import { PROMPTS } from "./prompts";
import { knowledge } from "./knowledge";
import type { CrawlParams, Env } from "./types";

const STEP_CONFIG = {
  retries: { limit: 2, delay: "5 seconds" as const, backoff: "exponential" as const },
  timeout: "3 minutes" as const,
};

/**
 * Durable, retryable crawl → summarize → embed pipeline.
 * Each page is its own step, so a failure on one page retries only that page
 * and completed work is never repeated.
 */
export class CrawlWorkflow extends WorkflowEntrypoint<Env, CrawlParams> {
  async run(event: WorkflowEvent<CrawlParams>, step: WorkflowStep) {
    const { crawlId, url, maxPages } = event.payload;
    const store = knowledge(this.env);

    const queue = await step.do("discover links", STEP_CONFIG, async () => {
      await store.updateCrawl(crawlId, { status: "crawling" });
      const root = await fetchAndExtract(url);
      const urls = [root.url, ...root.links.filter((l) => l !== root.url)];
      return [...new Set(urls)].slice(0, maxPages);
    });

    const pages: { url: string; title: string; summary: string }[] = [];
    let lastError = "";
    for (let i = 0; i < queue.length; i++) {
      const pageUrl = queue[i];
      try {
        const page = await step.do(`page ${i}: ${pageUrl}`.slice(0, 200), STEP_CONFIG, async () => {
          const extracted = await fetchAndExtract(pageUrl);
          if (extracted.text.length < 50) return null;

          const summary = await runChat(this.env, [
            { role: "system", content: PROMPTS.pageSummary },
            { role: "user", content: `Title: ${extracted.title}\nURL: ${extracted.url}\n\n${extracted.text.slice(0, 12_000)}` },
          ], { maxTokens: 400, temperature: 0.2 });

          const texts = chunkText(extracted.text).slice(0, 40);
          const vectors = await embed(this.env, texts);
          await store.addDocument({
            url: extracted.url,
            title: extracted.title,
            summary,
            crawlId,
            chunks: texts.map((text, j) => ({ text, embedding: vectors[j] })),
          });
          return { url: extracted.url, title: extracted.title, summary };
        });
        if (page) pages.push(page);
      } catch (err) {
        // A page that keeps failing after retries is skipped, not fatal.
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`Skipping ${pageUrl}:`, err);
      }
      await step.do(`progress ${i}`, async () => {
        await store.updateCrawl(crawlId, { pages: pages.length });
      });
    }

    const siteSummary = await step.do("site summary", STEP_CONFIG, async () => {
      if (pages.length === 0) {
        await store.updateCrawl(crawlId, { status: "failed", error: lastError ? `All pages failed: ${lastError}` : "No readable pages found." });
        return null;
      }
      const digest = pages.map((p) => `## ${p.title} (${p.url})\n${p.summary}`).join("\n\n").slice(0, 16_000);
      const summary = await runChat(this.env, [
        { role: "system", content: PROMPTS.siteSummary },
        { role: "user", content: `Site: ${url}\n\n${digest}` },
      ], { maxTokens: 600, temperature: 0.3 });
      await store.updateCrawl(crawlId, { status: "complete", pages: pages.length, summary });
      return summary;
    });

    return { crawlId, pages: pages.length, summary: siteSummary };
  }
}
