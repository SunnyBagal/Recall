// Characterization tests: these assert what the share-link routes do today,
// oddities included — not what they should do.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { contents, shareLinks } from "../db/schema";
import { createTestApp, type TestApp } from "./helpers/app";
import { oneHot } from "./helpers/db";

let t: TestApp;
let ada: { userId: string; token: string };
let hash: string;

beforeAll(async () => {
  t = await createTestApp();
  ada = await t.createUser("ada");
  const grace = await t.createUser("grace");

  await t.db.insert(contents).values([
    {
      userId: ada.userId,
      link: "https://a.example",
      title: "Shared card",
      extractedText: "full text",
      embedding: oneHot(3),
    },
    { userId: grace.userId, link: "https://b.example", title: "Not ada's" },
  ]);
});

afterAll(async () => {
  await t.close();
});

describe("POST /api/v1/brain/share", () => {
  test("creates a 12-character hash and returns the same one on repeat calls", async () => {
    const first = await t.request("POST", "/api/v1/brain/share", {
      token: ada.token,
      body: { share: true },
    });
    expect(first.status).toBe(200);
    expect(Object.keys(first.body)).toEqual(["hash"]);
    expect(first.body.hash).toMatch(/^[A-Za-z0-9_-]{12}$/);
    hash = first.body.hash;

    const second = await t.request("POST", "/api/v1/brain/share", {
      token: ada.token,
      body: { share: true },
    });
    expect(second.body).toEqual({ hash });

    expect(await t.db.select().from(shareLinks)).toHaveLength(1);
  });
});

describe("GET /api/v1/brain/:shareLink", () => {
  test("needs no token and returns the owner's username and full content rows", async () => {
    const res = await t.request("GET", `/api/v1/brain/${hash}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe("ada");
    expect(res.body.content).toHaveLength(1);

    // The public response is an unprojected `select()`: every column, including
    // the owner's userId, the extracted text and the 1536-dim embedding.
    const row = res.body.content[0];
    expect(Object.keys(row).sort()).toEqual([
      "createdAt",
      "embedUrl",
      "embedding",
      "extractedText",
      "favicon",
      "id",
      "link",
      "ogDescription",
      "ogImage",
      "ogSiteName",
      "ogTitle",
      "processingStatus",
      "searchVector",
      "summary",
      "tags",
      "title",
      "type",
      "updatedAt",
      "userId",
    ]);
    expect(row.title).toBe("Shared card");
    expect(row.userId).toBe(ada.userId);
    expect(row.extractedText).toBe("full text");
    expect(row.embedding).toHaveLength(1536);
    expect(row.searchVector).toBe("'card':2A 'share':1A");
  });

  test("an unknown hash is a 404", async () => {
    const res = await t.request("GET", "/api/v1/brain/doesnotexist");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "Invalid share link" });
  });
});

describe("POST /api/v1/brain/share with share: false", () => {
  test("removes the link, after which the hash is a 404", async () => {
    const res = await t.request("POST", "/api/v1/brain/share", {
      token: ada.token,
      body: { share: false },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Removed shareable link" });

    const gone = await t.request("GET", `/api/v1/brain/${hash}`);
    expect(gone.status).toBe(404);
  });

  test("a body without `share` also removes the link", async () => {
    await t.request("POST", "/api/v1/brain/share", { token: ada.token, body: { share: true } });

    const res = await t.request("POST", "/api/v1/brain/share", { token: ada.token, body: {} });

    expect(res.body).toEqual({ message: "Removed shareable link" });
    expect(await t.db.select().from(shareLinks)).toHaveLength(0);
  });
});
