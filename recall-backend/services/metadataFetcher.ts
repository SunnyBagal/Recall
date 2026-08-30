import { parseHTML } from "linkedom";
import type { DetectedType } from "./linkDetector";
import { Readability } from "@mozilla/readability";

// linkedom's document type. The project's tsconfig has no DOM lib, so the
// global `Document` type isn't available here.
type Doc = ReturnType<typeof parseHTML>["document"];

export interface MetadataResult {
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogSiteName: string | null;
  favicon: string | null;
  extractedText: string | null;
  /**
   * True when the site refused us (non-2xx, or a bot-challenge page served
   * with any status). Callers should NOT treat the returned og* fields as real
   * page metadata in that case — they are URL-derived placeholders.
   */
  blocked: boolean;
}

// Tried in order until one returns a usable page. Sites disagree about which
// client they trust: Medium serves 200 to the honest bot UA and 403 (Cloudflare)
// to a browser UA from the same IP, while other hosts do the reverse. Trying
// both recovers a large slice of "unsupported" links.
const UA_PROFILES: Array<{ label: string; headers: Record<string, string> }> = [
  {
    label: "bot",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RecallBot/1.0; +https://recall.app)",
      Accept: "text/html,application/xhtml+xml",
    },
  },
  {
    label: "browser",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  },
];

// Bot-wall interstitials. These pages are valid HTML and often arrive with a
// 200, so status alone can't catch them — without this check the wall's own
// <title> ("Just a moment...", "Attention Required! | Cloudflare") gets stored
// as the article title and its body text gets summarized and embedded.
export const CHALLENGE_TITLE = /just a moment|attention required|access denied|security check|are you a robot|enable (javascript|cookies)|verifying you are human|ddos protection/i;

function looksLikeChallenge(document: Doc): boolean {
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  if (CHALLENGE_TITLE.test(title)) return true;
  // Challenge pages are tiny and carry no Open Graph data.
  const hasOg = document.querySelector('meta[property^="og:"]');
  const bodyLen = document.body?.textContent?.trim().length ?? 0;
  return !hasOg && bodyLen > 0 && bodyLen < 600 &&
    /blocked|cloudflare|captcha|unusual traffic/i.test(document.body?.textContent ?? "");
}

/**
 * Readable placeholders derived from the URL itself, for when a site blocks us.
 * Article URLs usually carry a descriptive slug, so a Medium link still renders
 * as a titled card instead of a bare URL or a Cloudflare error.
 */
function fallbackFromUrl(rawUrl: string): {
  ogTitle: string | null;
  ogSiteName: string | null;
  favicon: string | null;
} {
  try {
    const url = new URL(rawUrl);
    const segment = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const slug = decodeURIComponent(segment)
      .replace(/\.(html?|php|aspx?)$/i, "")
      .replace(/[-_][0-9a-f]{8,}$/i, "") // Medium-style trailing id
      .replace(/[-_]+/g, " ")
      .trim();
    const ogTitle = slug.length > 2
      ? slug.replace(/\b\w/g, (c) => c.toUpperCase())
      : null;
    const host = url.hostname.replace(/^www\./, "");
    const ogSiteName = host.split(".")[0]!.replace(/\b\w/g, (c) => c.toUpperCase());
    return { ogTitle, ogSiteName, favicon: `${url.origin}/favicon.ico` };
  } catch {
    return { ogTitle: null, ogSiteName: null, favicon: null };
  }
}

function getMetaContent(document: Doc, attr: string, value: string): string | null {
  const el = document.querySelector(`meta[${attr}="${value}"]`);
  return el?.getAttribute("content")?.trim() || null;
}

function resolveUrl(base: string, relative:string | null): string | null {
  if (!relative) return null;
  try {
    return new URL(relative, base).href; 
  } catch{
    return null
  }
}

function extractFavicon(document: Doc, baseUrl: string): string | null {
  const selectors = [
    'link[rel="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
  ]

  for ( const selector of selectors ){
    const el = document.querySelector(selector);
    const href = el?.getAttribute("href");
    if (href) return resolveUrl(baseUrl, href);
  }

  try {
    const url = new URL(baseUrl);
    return `${url.origin}/favicon.ico`
  } catch {
    return null;
  }

}

export async function fetchMetadata(
  url: string,
  type: DetectedType
) : Promise<MetadataResult> {

  const fallback = fallbackFromUrl(url);

  // Returned when the page can't be read. Carries URL-derived placeholders so
  // the card still renders with a title, and blocked=true so callers can tell
  // real metadata from a guess.
  const unavailable: MetadataResult = {
    ogTitle: fallback.ogTitle,
    ogDescription: null,
    ogImage: null,
    ogSiteName: fallback.ogSiteName,
    favicon: fallback.favicon,
    extractedText: null,
    blocked: true,
  };

  try{

    let html: string | null = null;
    let lastReason = "";

    for (const profile of UA_PROFILES) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: profile.headers,
          redirect: "follow",
        });

        // Without this the fetcher happily parses 403/404/503 error pages and
        // stores their <title> as the article's — the bug that made blocked
        // links show up as "Just a moment..." cards.
        if (!response.ok) {
          lastReason = `${profile.label}: HTTP ${response.status}`;
          continue;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
          // A non-HTML 200 (PDF, image, JSON) is a definitive answer, not a
          // block — retrying with another UA would return the same thing.
          return { ...unavailable, blocked: false };
        }

        const body = await response.text();
        const { document: probe } = parseHTML(body);
        if (looksLikeChallenge(probe)) {
          lastReason = `${profile.label}: bot challenge`;
          continue;
        }

        html = body;
        break;
      } catch (err) {
        lastReason = `${profile.label}: ${(err as Error).message}`;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (html === null) {
      console.warn(`[metadataFetcher] could not read ${url} (${lastReason}) — using URL-derived title`);
      return unavailable;
    }

    const {document} = parseHTML(html);

    const ogTitle =
      getMetaContent(document, "property", "og:title") ??
      document.querySelector("title")?.textContent?.trim() ??
      null;

    const ogDescription = 
      getMetaContent(document,"property",  "og:description") ??
      getMetaContent(document,"name","description") ??
      null;

    const rawOgImage = getMetaContent(document, "property", "og:image");
    const ogImage = resolveUrl(url, rawOgImage);

    const ogSiteName = 
      getMetaContent(document, "property", "og:site_name") ?? null;

    const favicon = extractFavicon(document, url);

    let extractedText: string | null = null;

    if (type === "article" || type === "link") {

      try {
        const { document: clonedDoc } = parseHTML(html);
        const reader = new Readability(clonedDoc as any);
        const article = reader.parse();

        if (article?.textContent){
          extractedText = article.textContent.trim().slice(0, 10_000);
        }
      } catch(err){
        // Readability fails on some layouts; og data is still usable, so this
        // is non-fatal — but log it instead of swallowing it silently.
        console.warn(`[metadataFetcher] readability failed for ${url}: `, (err as Error).message);
      }
    }

    return {
      ogTitle: ogTitle ?? fallback.ogTitle,
      ogDescription,
      ogImage,
      ogSiteName: ogSiteName ?? fallback.ogSiteName,
      favicon,
      extractedText,
      blocked: false,
    }

  } catch(err) {

    console.error(`[metadataFetcher] failed to fetch ${url}: `, (err as Error).message);
    return unavailable;
  }
}
