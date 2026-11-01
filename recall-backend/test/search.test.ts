// Characterization tests: these assert what search does today, oddities
// included — not what it should do. The queries in services/searchService.ts
// run unmodified against PGlite + pgvector.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { contents } from "../db/schema";
import { hybridSearch, type HybridSearchTimings } from "../services/searchService";
import { createTestApp, type TestApp } from "./helpers/app";
import { oneHot } from "./helpers/db";

let t: TestApp;
let ada: { userId: string; token: string };
let grace: { userId: string; token: string };

const titles = (rows: any[]) => rows.map((r) => r.title);

beforeAll(async () => {
  t = await createTestApp();
  ada = await t.createUser("ada");
  grace = await t.createUser("grace");

  await t.db.insert(contents).values([
    // matches "postgres" lexically (title, weight A) and the query vector exactly
    { userId: ada.userId, link: "https://a.example", title: "Postgres indexing guide", embedding: oneHot(0) },
    // matches "postgres" lexically only (summary, weight C); orthogonal vector
    { userId: ada.userId, link: "https://b.example", title: "Storage engines", summary: "How postgres stores rows", embedding: oneHot(1) },
    // no lexical match; close to the query vector (cosine similarity ~0.71)
    { userId: ada.userId, link: "https://c.example", title: "Query planners", embedding: oneHot(0).map((x, i) => (i === 2 ? 1 : x)) },
    // no lexical match, no embedding (what a row looks like before the worker runs)
    { userId: ada.userId, link: "https://d.example", title: "React hooks" },
    // another user's row that would match both arms
    { userId: grace.userId, link: "https://e.example", title: "Postgres for grace", embedding: oneHot(0) },
  ]);
});

afterAll(async () => {
  await t.close();
});

describe("hybridSearch", () => {
  test("fuses the vector and keyword arms with RRF, scoped to the user", async () => {
    const results = await hybridSearch(t.db, ada.userId, "postgres", oneHot(0));

    // In both arms -> first. Then one row from each arm at the same rank
    // (equal RRF score; the vector arm's row was inserted into the map first).
    expect(titles(results)).toEqual([
      "Postgres indexing guide",
      "Query planners",
      "Storage engines",
    ]);
  });

  test("rows from the vector arm carry a similarity field; keyword-only rows do not", async () => {
    const results = await hybridSearch(t.db, ada.userId, "postgres", oneHot(0));
    const byTitle = Object.fromEntries(results.map((r) => [r.title, r]));

    expect(byTitle["Postgres indexing guide"].similarity).toBe(1);
    expect(byTitle["Query planners"].similarity).toBeCloseTo(Math.SQRT1_2, 5);
    expect("similarity" in byTitle["Storage engines"]).toBe(false);

    expect(Object.keys(byTitle["Storage engines"]).sort()).toEqual([
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
    expect(byTitle["Storage engines"].username).toBe("ada");
  });

  test("with a null embedding only the keyword arm runs, ranked by ts_rank", async () => {
    const timings: HybridSearchTimings = { vectorMs: -1, keywordMs: -1, fusionMs: -1 };
    const results = await hybridSearch(t.db, ada.userId, "postgres", null, timings);

    // title match (weight A) outranks summary match (weight C)
    expect(titles(results)).toEqual(["Postgres indexing guide", "Storage engines"]);
    expect(timings.vectorMs).toBe(0);
    expect(timings.keywordMs).toBeGreaterThanOrEqual(0);
    expect(timings.fusionMs).toBeGreaterThanOrEqual(0);
  });

  test("vector matches at or below 0.3 similarity are dropped", async () => {
    // oneHot(1) is orthogonal to everything except "Storage engines".
    const results = await hybridSearch(t.db, ada.userId, "zzzznomatch", oneHot(1));

    expect(titles(results)).toEqual(["Storage engines"]);
  });

  test("a stopword-only query matches every row of the user", async () => {
    const results = await hybridSearch(t.db, ada.userId, "the", null);

    expect(titles(results).sort()).toEqual([
      "Postgres indexing guide",
      "Query planners",
      "React hooks",
      "Storage engines",
    ]);
  });
});

describe("GET /api/v1/search", () => {
  test("requires a non-blank query", async () => {
    const res = await t.request("GET", "/api/v1/search?q=%20%20", { token: ada.token });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Query is required" });
  });

  test("embeds the trimmed query and returns the fused results with a total", async () => {
    t.embedding.byText.set("postgres", oneHot(0));

    const res = await t.request("GET", "/api/v1/search?q=%20postgres%20", { token: ada.token });

    expect(res.status).toBe(200);
    expect(t.embedding.calls).toEqual(["postgres"]);
    expect(titles(res.body.results)).toEqual([
      "Postgres indexing guide",
      "Query planners",
      "Storage engines",
    ]);
    expect(res.body.total).toBe(3);
  });

  test("falls back to keyword-only results when no embedding is available", async () => {
    // the fake returns null for unknown text, like the real one without OPENAI_API_KEY
    const res = await t.request("GET", "/api/v1/search?q=hooks", { token: ada.token });

    expect(res.status).toBe(200);
    expect(titles(res.body.results)).toEqual(["React hooks"]);
    expect(res.body.total).toBe(1);
  });
});
