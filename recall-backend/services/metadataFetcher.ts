import { parseHTML } from "linkedom";
import type { DetectedType } from "./linkDetector";
import { Readability } from "@mozilla/readability";


export interface MetadataResult {
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogSiteName: string | null;
  favicon: string | null;
  extractedText: string | null;

}

function getMetaContent(document: Document, attr: string, value: string): string | null {
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

function extractFavicon(document: Document, baseUrl: string): string | null {
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

  const empty: MetadataResult = {
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    ogSiteName: null,
    favicon: null,
    extractedText: null,
  };

  try{

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000)
    const response = await fetch (url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
        "Mozilla/5.0 (compatible; RecallBot/1.0; +https://recall.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")){
      return empty;
    }

    const html = await response.text();

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

      }
    }

    return {
      ogTitle, ogDescription, ogImage, ogSiteName, favicon, extractedText,
    }
  
  } catch(err) {

    console.error(`[metadataFetcher] failed to fetch ${url}: `, (err as Error).message);
    return empty;
  }
}