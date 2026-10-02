// Characterization tests: these assert what fetchMetadata does today,
// oddities included — not what it should do. fetch is stubbed; nothing here
// reaches the network.
import { afterEach, describe, expect, test } from "bun:test";
import { fetchMetadata } from "../services/metadataFetcher";
import { htmlResponse, restoreFetch, stubFetch } from "./helpers/network";

const URL_ = "https://blog.example.com/posts/why-rust-is-fast-3f2a9c1b7d4e";

const PARAGRAPH = "Rust is fast because it compiles to native code without a garbage collector. ".repeat(12);

const ARTICLE_HTML = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="Why Rust Is Fast">
  <meta property="og:description" content="Zero-cost abstractions, explained.">
  <meta name="description" content="Plain description (unused: og wins).">
  <meta property="og:image" content="/img/cover.png">
  <meta property="og:site_name" content="Example Blog">
  <link rel="icon" href="/static/icon.png">
</head><body><article><h1>Why Rust Is Fast</h1><p>${PARAGRAPH}</p></article></body></html>`;

const userAgent = (init: RequestInit | undefined) =>
  (init!.headers as Record<string, string>)["User-Agent"] ?? "";

afterEach(() => {
  restoreFetch();
});

describe("fetchMetadata", () => {
  test("reads Open Graph data, resolves relative URLs and extracts article text", async () => {
    const calls = stubFetch(() => htmlResponse(ARTICLE_HTML));

    const result = await fetchMetadata(URL_, "article");

    expect(result).toMatchObject({
      ogTitle: "Why Rust Is Fast",
      ogDescription: "Zero-cost abstractions, explained.",
      ogImage: "https://blog.example.com/img/cover.png",
      ogSiteName: "Example Blog",
      favicon: "https://blog.example.com/static/icon.png",
      blocked: false,
    });
    expect(result.extractedText).toContain("Rust is fast because it compiles to native code");

    // one request, with the bot user agent, following redirects
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_);
    expect(userAgent(calls[0]!.init)).toBe(
      "Mozilla/5.0 (compatible; RecallBot/1.0; +https://recall.app)",
    );
    expect(calls[0]!.init!.redirect).toBe("follow");
  });

  test("text is only extracted for article and link types", async () => {
    stubFetch(() => htmlResponse(ARTICLE_HTML));

    const result = await fetchMetadata(URL_, "youtube");

    expect(result.ogTitle).toBe("Why Rust Is Fast");
    expect(result.extractedText).toBeNull();
  });

  test("without Open Graph tags it falls back to <title>, meta description, URL site name and /favicon.ico", async () => {
    stubFetch(() =>
      htmlResponse(
        `<html><head><title> Plain page </title><meta name="description" content="Plain description."></head>` +
          `<body><p>${PARAGRAPH}</p></body></html>`,
      ),
    );

    const result = await fetchMetadata(URL_, "youtube");

    expect(result).toEqual({
      ogTitle: "Plain page",
      ogDescription: "Plain description.",
      ogImage: null,
      ogSiteName: "Blog",
      favicon: "https://blog.example.com/favicon.ico",
      extractedText: null,
      blocked: false,
    });
  });

  test("retries with a browser user agent when the bot one is refused", async () => {
    const calls = stubFetch((_url, init) =>
      userAgent(init).includes("RecallBot")
        ? new Response("forbidden", { status: 403 })
        : htmlResponse(ARTICLE_HTML),
    );

    const result = await fetchMetadata(URL_, "article");

    expect(result.blocked).toBe(false);
    expect(result.ogTitle).toBe("Why Rust Is Fast");
    expect(calls).toHaveLength(2);
    expect(userAgent(calls[1]!.init)).toContain("Chrome/126.0.0.0");
  });

  test("when every attempt is refused it returns URL-derived placeholders, blocked", async () => {
    const calls = stubFetch(() => new Response("forbidden", { status: 403 }));

    const result = await fetchMetadata(URL_, "article");

    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      // last path segment, trailing hex id stripped, title-cased
      ogTitle: "Why Rust Is Fast",
      ogDescription: null,
      ogImage: null,
      // first label of the host, capitalized
      ogSiteName: "Blog",
      favicon: "https://www.google.com/s2/favicons?domain=blog.example.com&sz=64",
      extractedText: null,
      blocked: true,
    });
  });

  test("a bot-challenge page served with a 200 counts as blocked", async () => {
    const calls = stubFetch(() =>
      htmlResponse("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>"),
    );

    const result = await fetchMetadata(URL_, "article");

    expect(calls).toHaveLength(2);
    expect(result.blocked).toBe(true);
    expect(result.ogTitle).toBe("Why Rust Is Fast");
  });

  test("a network error on every attempt is blocked, not thrown", async () => {
    stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    const result = await fetchMetadata(URL_, "article");

    expect(result.blocked).toBe(true);
    expect(result.extractedText).toBeNull();
  });

  test("a non-HTML 200 returns the URL placeholders with blocked: false, after one request", async () => {
    const calls = stubFetch(
      () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
    );

    const result = await fetchMetadata("https://example.com/files/annual-report.pdf", "link");

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      // .pdf is not one of the stripped extensions, and it gets title-cased too
      ogTitle: "Annual Report.Pdf",
      ogDescription: null,
      ogImage: null,
      ogSiteName: "Example",
      favicon: "https://www.google.com/s2/favicons?domain=example.com&sz=64",
      extractedText: null,
      blocked: false,
    });
  });

  test("a URL that cannot be parsed yields all-null placeholders, blocked", async () => {
    stubFetch(() => {
      throw new TypeError("Invalid URL");
    });

    const result = await fetchMetadata("not a url", "link");

    expect(result).toEqual({
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
      ogSiteName: null,
      favicon: null,
      extractedText: null,
      blocked: true,
    });
  });
});
