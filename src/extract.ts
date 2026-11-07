export interface ExtractedPage {
  url: string;
  title: string;
  text: string;
  links: string[];
}

const USER_AGENT = "cf-ai-edge-nav/1.0 (Cloudflare Workers crawler)";
const SKIP_TAGS = "script,style,noscript,svg,template,iframe,nav,footer,head";
const BLOCK_TAGS = "p,div,section,article,li,h1,h2,h3,h4,h5,h6,br,tr,pre,blockquote";

/** Fetches a page and extracts readable text, title and same-origin links using HTMLRewriter. */
export async function fetchAndExtract(rawUrl: string): Promise<ExtractedPage> {
  const res = await fetch(rawUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Fetch ${rawUrl} failed: HTTP ${res.status}`);

  const finalUrl = res.url || rawUrl;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/plain")) {
    const text = (await res.text()).slice(0, 200_000);
    return { url: finalUrl, title: finalUrl, text, links: [] };
  }
  if (!contentType.includes("html")) throw new Error(`Unsupported content type: ${contentType}`);

  const base = new URL(finalUrl);
  const parts: string[] = [];
  const links = new Set<string>();
  let title = "";
  let skipDepth = 0;
  let inTitle = false;

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el) {
        inTitle = true;
        el.onEndTag(() => { inTitle = false; });
      },
      text(t) { title += t.text; },
    })
    .on(SKIP_TAGS, {
      element(el) {
        skipDepth++;
        el.onEndTag(() => { skipDepth--; });
      },
    })
    .on(BLOCK_TAGS, {
      element() { parts.push("\n"); },
    })
    .on("a[href]", {
      element(el) {
        const href = el.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) return;
        try {
          const u = new URL(href, base);
          u.hash = "";
          if (u.origin === base.origin && /^https?:$/.test(u.protocol)) links.add(u.toString());
        } catch { /* ignore malformed hrefs */ }
      },
    })
    .onDocument({
      text(t) {
        if (skipDepth === 0 && !inTitle) parts.push(t.text);
      },
    });

  // Consume the transformed stream so all handlers run.
  await rewriter.transform(res).arrayBuffer();

  const text = decodeEntities(parts.join(""))
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 200_000);

  return {
    url: finalUrl,
    title: decodeEntities(title).trim() || finalUrl,
    text,
    links: [...links].filter((l) => !/\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|mp3|css|js|ico)(\?|$)/i.test(l)),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
