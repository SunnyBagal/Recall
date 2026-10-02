// Characterization tests: these assert what the content routes do today,
// oddities included — not what they should do.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { contents } from "../db/schema";
import { createTestApp, type TestApp } from "./helpers/app";
import { htmlResponse, restoreFetch, stubFetch } from "./helpers/network";

const ARTICLE_HTML = `<!doctype html><html><head>
  <title>Fallback title</title>
  <meta property="og:title" content="How Postgres Indexes Work">
  <meta property="og:description" content="A tour of btree and gin.">
  <meta property="og:image" content="/img/cover.png">
  <meta property="og:site_name" content="DB Weekly">
  <link rel="icon" href="/static/icon.png">
</head><body><article><h1>How Postgres Indexes Work</h1>
  <p>${"Indexes speed up reads at the cost of writes. ".repeat(20)}</p>
</article></body></html>`;

let t: TestApp;
let ada: { userId: string; token: string };
let grace: { userId: string; token: string };

beforeAll(async () => {
  t = await createTestApp();
  ada = await t.createUser("ada");
  grace = await t.createUser("grace");
});

afterEach(() => {
  restoreFetch();
});

afterAll(async () => {
  await t.close();
});

describe("auth middleware", () => {
  test("rejects a missing token", async () => {
    const res = await t.request("GET", "/api/v1/content");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ msg: "No token provided" });
  });

  test("expects the raw token — a Bearer prefix is rejected", async () => {
    const res = await t.request("GET", "/api/v1/content", { token: `Bearer ${ada.token}` });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ msg: "Invalid token" });
  });
});

describe("POST /api/v1/content", () => {
  test("requires a link", async () => {
    const res = await t.request("POST", "/api/v1/content", { token: ada.token, body: {} });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Link is required" });
  });

  test("stores fetched metadata as pending and enqueues a job with the contentId", async () => {
    const fetchCalls = stubFetch(() => htmlResponse(ARTICLE_HTML));
    const link = "https://dbweekly.example/posts/how-postgres-indexes-work";

    const res = await t.request("POST", "/api/v1/content", { token: ada.token, body: { link } });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Content created");
    expect(fetchCalls.map((c) => c.url)).toEqual([link]);

    const [row] = await t.db.select().from(contents).where(eq(contents.id, res.body.contentId));
    expect(row).toMatchObject({
      link,
      // no title in the request, so it falls back to the fetched og:title
      title: "How Postgres Indexes Work",
      type: "article",
      userId: ada.userId,
      ogTitle: "How Postgres Indexes Work",
      ogDescription: "A tour of btree and gin.",
      ogImage: "https://dbweekly.example/img/cover.png",
      ogSiteName: "DB Weekly",
      favicon: "https://dbweekly.example/static/icon.png",
      embedUrl: null,
      summary: null,
      tags: [],
      embedding: null,
      processingStatus: "pending",
    });
    expect(row!.extractedText).toContain("Indexes speed up reads");

    expect(t.queue.calls).toEqual([
      { name: "process-content", data: { contentId: res.body.contentId }, opts: { delay: 1000 } },
    ]);
  });

  test("an unreachable link is still saved, with a title derived from the URL", async () => {
    stubFetch(() => new Response("nope", { status: 403 }));
    const before = t.queue.calls.length;

    const res = await t.request("POST", "/api/v1/content", {
      token: ada.token,
      body: { link: "https://medium.com/@someone/why-rust-is-fast-3f2a9c1b7d4e", title: "My title" },
    });

    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(contents).where(eq(contents.id, res.body.contentId));
    expect(row).toMatchObject({
      title: "My title",
      type: "article",
      ogTitle: "Why Rust Is Fast",
      ogSiteName: "Medium",
      favicon: "https://www.google.com/s2/favicons?domain=medium.com&sz=64",
      extractedText: null,
      processingStatus: "pending",
    });
    expect(t.queue.calls.length).toBe(before + 1);
  });
});

describe("GET /api/v1/content", () => {
  test("lists only the caller's content, oldest first, without extractedText", async () => {
    const res = await t.request("GET", "/api/v1/content", { token: ada.token });

    expect(res.status).toBe(200);
    expect(res.body.content.map((c: any) => c.title)).toEqual([
      "How Postgres Indexes Work",
      "My title",
    ]);
    expect(Object.keys(res.body.content[0]).sort()).toEqual([
      "createdAt",
      "embedUrl",
      "favicon",
      "id",
      "link",
      "ogDescription",
      "ogImage",
      "ogSiteName",
      "ogTitle",
      "processingStatus",
      "summary",
      "tags",
      "title",
      "type",
      "username",
    ]);
    expect(res.body.content[0].username).toBe("ada");

    const other = await t.request("GET", "/api/v1/content", { token: grace.token });
    expect(other.body).toEqual({ content: [] });
  });
});

describe("DELETE /api/v1/content", () => {
  test("deletes the caller's content and 404s for someone else's", async () => {
    const list = await t.request("GET", "/api/v1/content", { token: ada.token });
    const contentId = list.body.content[0].id;

    const notMine = await t.request("DELETE", "/api/v1/content", {
      token: grace.token,
      body: { contentId },
    });
    expect(notMine.status).toBe(404);
    expect(notMine.body).toEqual({ message: "Content not found" });

    const mine = await t.request("DELETE", "/api/v1/content", {
      token: ada.token,
      body: { contentId },
    });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ message: "Deleted" });

    const after = await t.request("GET", "/api/v1/content", { token: ada.token });
    expect(after.body.content.map((c: any) => c.title)).toEqual(["My title"]);
  });

  test("a contentId that is not a uuid is a 500", async () => {
    const res = await t.request("DELETE", "/api/v1/content", {
      token: ada.token,
      body: { contentId: "not-a-uuid" },
    });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Failed to delete content" });
  });
});
