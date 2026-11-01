// Real Postgres + pgvector (eval/local-services.sh start), real node-postgres
// driver, real HNSW and GIN indexes. Vectors are hand-built with known cosines.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import jwt from "jsonwebtoken";
import request from "supertest";
import type pg from "pg";
import type { Db } from "../config/db";
import * as schema from "../db/schema";
import { contents, users } from "../db/schema";
import { createApp } from "../index";
import { EXACT_SCAN_MAX_ROWS, hybridSearch, nearestContents } from "../services/searchService";
import { fakeAnthropic, fakeEmbedding, fakeQueue } from "../test/helpers/app";
import { freshDatabase, testDatabaseUrl, vectorNear } from "./pg";

/** A database handle that records every SQL statement it sends. */
function loggingDb() {
  const queries: string[] = [];
  const logged = drizzle({
    connection: testDatabaseUrl(),
    schema,
    logger: { logQuery: (query) => queries.push(query) },
  });
  return {
    db: logged as unknown as Db,
    queries,
    close: () => (logged as any).$client.end() as Promise<void>,
  };
}

let db: Db;
let raw: pg.Client;
let close: () => Promise<void>;
let ada: string;
let grace: string;
let crowded: string;
let quiet: string;

// Must match the HNSW route in nearestContents().
const HNSW_SETTINGS =
  "set local enable_seqscan = off; set local enable_bitmapscan = off; set local enable_sort = off; set local hnsw.iterative_scan = relaxed_order";
const QUERY_AXIS = 0;
const query = vectorNear(QUERY_AXIS, 1);
const titles = (rows: any[]) => rows.map((r) => r.title);

async function user(name: string) {
  const [u] = await db.insert(users).values({ username: name, email: `${name}@example.org`, password: "x" }).returning();
  return u!.id;
}

beforeAll(async () => {
  ({ db, raw, close } = await freshDatabase());
  ada = await user("ada");
  grace = await user("grace");
  crowded = await user("crowded");
  quiet = await user("quiet");

  await db.insert(contents).values([
    { userId: ada, link: "https://1", title: "Graphene conductivity", embedding: vectorNear(QUERY_AXIS, 0.95, 1) },
    { userId: ada, link: "https://2", title: "Polymer science", summary: "Graphene composites", embedding: vectorNear(QUERY_AXIS, 0.6, 2) },
    { userId: ada, link: "https://3", title: "Battery cathodes", embedding: vectorNear(QUERY_AXIS, 0.8, 3) },
    { userId: ada, link: "https://4", title: "Unrelated cooking", embedding: vectorNear(QUERY_AXIS, 0.1, 4) },
    { userId: ada, link: "https://5", title: "Graphene without vector" },
    { userId: grace, link: "https://6", title: "Graphene for grace", embedding: vectorNear(QUERY_AXIS, 0.99, 5) },
  ]);
  await raw.query("analyze contents");
});

afterAll(async () => {
  await close();
});

describe("vector arm", () => {
  it("orders by cosine similarity and drops rows at or below 0.3", async () => {
    const rows = await hybridSearch(db, ada, "ignored", query, undefined, "vector");
    expect(titles(rows)).toEqual(["Graphene conductivity", "Battery cathodes", "Polymer science"]);
    expect(rows[0]!.similarity).toBeCloseTo(0.95, 3);
  });

  it("skips rows with a NULL embedding and other users' rows", async () => {
    const rows = await hybridSearch(db, ada, "ignored", query, undefined, "vector");
    expect(titles(rows)).not.toContain("Graphene without vector");
    expect(titles(rows)).not.toContain("Graphene for grace");
  });

  it("with the override and iterative scan, the plan uses the HNSW index", async () => {
    await raw.query(`begin; ${HNSW_SETTINGS}`);
    const { rows } = await raw.query(
      `explain select c.id from contents c join users u on c.user_id = u.id
       where c.user_id = $1 order by c.embedding <=> $2 limit 10`,
      [ada, JSON.stringify(query)],
    );
    await raw.query("rollback");
    expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("idx_contents_embedding_hnsw");
  });

  it("with the btree present, turning off seq scans alone does not give HNSW", async () => {
    await raw.query("begin; set local enable_seqscan = off");
    const { rows } = await raw.query(
      `explain select c.id from contents c join users u on c.user_id = u.id
       where c.user_id = $1 order by c.embedding <=> $2 limit 10`,
      [ada, JSON.stringify(query)],
    );
    await raw.query("rollback");
    expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).not.toContain("idx_contents_embedding_hnsw");
  });

  it("the override does not leak out of its transaction", async () => {
    await hybridSearch(db, ada, "x", query, undefined, "vector");
    const check = await db.execute(sql`show enable_seqscan`);
    expect((check as any).rows[0].enable_seqscan).toBe("on");
  });
});

describe("FTS arm", () => {
  it("title (A) outranks summary (C)", async () => {
    const rows = await hybridSearch(db, ada, "graphene", null, undefined, "fts");
    expect(titles(rows)[rows.length - 1]).toBe("Polymer science");
    expect(titles(rows)).toContain("Graphene conductivity");
  });

  it("is scoped to the caller", async () => {
    const rows = await hybridSearch(db, ada, "graphene", null, undefined, "fts");
    expect(titles(rows)).not.toContain("Graphene for grace");
  });

  it("stems English: 'conductivities' finds 'conductivity'", async () => {
    const rows = await hybridSearch(db, ada, "conductivities", null, undefined, "fts");
    expect(titles(rows)).toEqual(["Graphene conductivity"]);
  });

  it("regression: one unmatched term no longer empties the results", async () => {
    const rows = await hybridSearch(db, ada, "graphene conductivity measurements", null, undefined, "fts");
    expect(titles(rows)).toContain("Graphene conductivity");
  });

  it("a document matching more of the query terms ranks higher", async () => {
    const rows = await hybridSearch(db, ada, "graphene conductivity", null, undefined, "fts");
    expect(titles(rows)[0]).toBe("Graphene conductivity");
    expect(titles(rows)).toContain("Polymer science");
  });

  it("a query with no matching term still returns nothing", async () => {
    expect(await hybridSearch(db, ada, "zzznomatch qqqnomatch", null, undefined, "fts")).toEqual([]);
  });

  it("a quoted phrase stays a phrase", async () => {
    const rows = await hybridSearch(db, ada, '"conductivity graphene"', null, undefined, "fts");
    expect(rows).toEqual([]);
    const inOrder = await hybridSearch(db, ada, '"graphene conductivity"', null, undefined, "fts");
    expect(titles(inOrder)).toEqual(["Graphene conductivity"]);
  });

  it("a -negation still excludes, and does not match every other row", async () => {
    const rows = await hybridSearch(db, ada, "graphene -conductivity", null, undefined, "fts");
    expect(titles(rows)).toContain("Polymer science");
    expect(titles(rows)).not.toContain("Graphene conductivity");
    expect(titles(rows)).not.toContain("Unrelated cooking");
  });

  it("hyphenated words are not treated as negation", async () => {
    await db.insert(contents).values({ userId: grace, link: "https://hy", title: "Long-term outcomes" });
    const rows = await hybridSearch(db, grace, "long-term zzznomatch", null, undefined, "fts");
    expect(titles(rows)).toContain("Long-term outcomes");
  });

  it("KNOWN LIMITATION: extracted_text is not searched", async () => {
    const [row] = await db
      .insert(contents)
      .values({ userId: grace, link: "https://7", title: "Plain", extractedText: "perovskite solar cells" })
      .returning();
    const rows = await hybridSearch(db, grace, "perovskite", null, undefined, "fts");
    expect(rows.map((r) => r.id)).not.toContain(row!.id);
  });

  it("KNOWN BUG: a stopword-only query returns arbitrary rows instead of nothing", async () => {
    const rows = await hybridSearch(db, ada, "the of and", null, undefined, "fts");
    expect(rows.length).toBe(5);
  });
});

describe("hybrid", () => {
  it("a row found by both arms ranks first, others follow", async () => {
    const rows = await hybridSearch(db, ada, "graphene", query);
    expect(titles(rows)[0]).toBe("Graphene conductivity");
    expect(new Set(titles(rows))).toEqual(
      new Set(["Graphene conductivity", "Polymer science", "Battery cathodes", "Graphene without vector"]),
    );
  });

  it("the default mode matches passing 'hybrid' explicitly", async () => {
    const a = await hybridSearch(db, ada, "graphene", query);
    const b = await hybridSearch(db, ada, "graphene", query, undefined, "hybrid");
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it("a null embedding degrades to FTS results", async () => {
    const a = await hybridSearch(db, ada, "graphene", null);
    const b = await hybridSearch(db, ada, "graphene", null, undefined, "fts");
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });

  it("the vector and fts modes run only their own arm", async () => {
    const vectorRows = await hybridSearch(db, ada, "cooking", query, undefined, "vector");
    expect(titles(vectorRows)).not.toContain("Unrelated cooking");

    const ftsRows = await hybridSearch(db, ada, "cooking", query, undefined, "fts");
    expect(titles(ftsRows)).toEqual(["Unrelated cooking"]);
  });
});

// Keep this block last: its rows change what the HNSW graph looks like for the
// blocks above.
describe("tenant isolation with the HNSW override", () => {
  // A row with no incoming graph links can't be reached by any index scan, however
  // far the iterative scan walks. This fixture leaves about 10% of rows like that,
  // at random, so `quiet`'s complete result set below depends on the exact fallback.
  // Seeded, so the vectors are the same on every run. Rows are drawn from one
  // distribution and split by closeness to the query, as tenants' rows share an
  // index in production. Hand-built orthogonal vectors don't work here: they
  // leave rows with no incoming graph links, which no index scan can reach.
  const DIMS = 1536;
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const random = seeded(42);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const normalize = (v: number[]) => {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);

  const center = normalize(Array.from({ length: DIMS }, gaussian));
  let quietIds: string[];
  let midling: string;

  beforeAll(async () => {
    midling = await user("midling");
    const rows = Array.from({ length: 700 }, (_, i) => {
      const spread = 0.01 + 0.03 * (i / 700);
      const embedding = normalize(center.map((x) => x + spread * gaussian()));
      return { embedding, sim: dot(embedding, center), i };
    }).sort((a, b) => b.sim - a.sim);

    // The nearest 600 are the crowd, above EXACT_SCAN_MAX_ROWS; `quiet` gets 5 from
    // the far end, all well above the 0.3 cutoff, and `midling` the next 20.
    // Inserted in the original, unsorted order.
    expect(EXACT_SCAN_MAX_ROWS).toBeLessThan(600);
    const owner = (rank: number) => (rank < 600 ? crowded : rank < 605 ? quiet : rank < 625 ? midling : grace);
    const values = rows
      .map((r, rank) => ({
        i: r.i,
        userId: owner(rank),
        link: `https://tenant/${r.i}`,
        title: `Tenant row ${r.i}`,
        extractedText: `Body of tenant row ${r.i}`,
        embedding: r.embedding,
      }))
      .sort((a, b) => a.i - b.i)
      .map(({ i: _i, ...v }) => v);
    await db.insert(contents).values(values);
    await raw.query("analyze contents");
    quietIds = (await raw.query("select id from contents where user_id = $1", [quiet])).rows.map((r) => r.id);
  });

  it("the fixture reproduces the bug: without the iterative scan, the small user gets nothing", async () => {
    await raw.query(`begin; ${HNSW_SETTINGS}; set local hnsw.iterative_scan = off`);
    const { rows } = await raw.query(
      "select id from contents where user_id = $1 order by embedding <=> $2 limit 10",
      [quiet, JSON.stringify(center)],
    );
    await raw.query("rollback");
    expect(rows.length).toBeLessThan(5);
  });

  it("regression: a small user gets all their rows when other tenants crowd the neighbourhood", async () => {
    const rows = await hybridSearch(db, quiet, "zzznomatch", center, undefined, "vector");
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(quietIds));
  });

  it("a small user's results come back in distance order, matching an exact search", async () => {
    const exact = await raw.query(
      `select c.id from contents c where c.user_id = $1 order by c.embedding <=> $2`,
      [quiet, JSON.stringify(center)],
    );
    const rows = await hybridSearch(db, quiet, "zzznomatch", center, undefined, "vector");
    expect(rows.map((r) => r.id)).toEqual(exact.rows.map((r) => r.id));
  });

  it("regression: the iterative scan fills the top 10 for a user the old path left short", async () => {
    await raw.query(`begin; ${HNSW_SETTINGS}; set local hnsw.iterative_scan = off`);
    const old = await raw.query(
      "select id from contents where user_id = $1 order by embedding <=> $2 limit 10",
      [midling, JSON.stringify(center)],
    );
    await raw.query("rollback");
    expect(old.rows.length).toBeLessThan(10);

    // Threshold lowered so this user takes the HNSW route.
    const logged = loggingDb();
    const rows = await nearestContents(logged.db, midling, center, { exactScanMaxRows: 5 });
    await logged.close();

    expect(logged.queries.join("\n")).toContain("hnsw.iterative_scan");
    expect(logged.queries.join("\n")).not.toContain("enable_indexscan");
    expect(rows).toHaveLength(10);
    const sims = rows.map((r) => r.similarity as number);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
  });

  describe("routing by the user's row count", () => {
    it("a small user gets one exact scan and never an HNSW walk", async () => {
      const logged = loggingDb();
      await nearestContents(logged.db, quiet, center);
      await logged.close();

      const text = logged.queries.join("\n");
      expect(text).toContain("enable_indexscan");
      expect(text).not.toContain("hnsw.iterative_scan");
      expect(logged.queries.filter((q) => q.includes("<=>") && q.includes("order by"))).toHaveLength(1);
    });

    it("a user above the threshold takes HNSW, without the exact fallback", async () => {
      const logged = loggingDb();
      const rows = await nearestContents(logged.db, crowded, center);
      await logged.close();

      const text = logged.queries.join("\n");
      expect(text).toContain("hnsw.iterative_scan");
      expect(text).not.toContain("enable_indexscan");
      expect(rows).toHaveLength(10);
    });

    it("a threshold of exactly the user's row count stays exact; one lower does not", async () => {
      const at = loggingDb();
      await nearestContents(at.db, quiet, center, { exactScanMaxRows: 5 });
      await at.close();
      expect(at.queries.join("\n")).not.toContain("hnsw.iterative_scan");

      const below = loggingDb();
      await nearestContents(below.db, quiet, center, { exactScanMaxRows: 4 });
      await below.close();
      expect(below.queries.join("\n")).toContain("hnsw.iterative_scan");
    });

    it("above the threshold, a short walk still falls back to an exact scan", async () => {
      // `quiet` has 5 rows, under the limit of 10, so the walk can't fill it.
      const logged = loggingDb();
      const rows = await nearestContents(logged.db, quiet, center, { exactScanMaxRows: 2 });
      await logged.close();

      expect(logged.queries.join("\n")).toContain("enable_indexscan");
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set(quietIds));
    });

    it("the bounded count reads the btree for a small user, and stops at the limit for a large one", async () => {
      const count = `select count(*)::int as n from (select 1 from contents where user_id = $1 limit ${EXACT_SCAN_MAX_ROWS + 1}) as bounded`;
      const { rows } = await raw.query(`explain ${count}`, [quiet]);
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("idx_contents_user_id");

      expect((await raw.query(count, [crowded])).rows[0].n).toBe(EXACT_SCAN_MAX_ROWS + 1);
    });
  });

  describe("POST /api/v1/chat, through the same search", () => {
    const chat = async (userId: string) => {
      const token = jwt.sign({ userId }, process.env.JWT_SECRET!);
      const anthropic = fakeAnthropic({ streamText: ["ok"] });
      const embedding = fakeEmbedding(center);
      const logged = loggingDb();
      const app = createApp({
        db: logged.db,
        queue: fakeQueue().queue,
        generateEmbedding: embedding.generateEmbedding,
        anthropic: anthropic.anthropic,
      });
      const res = await request(app).post("/api/v1/chat").set("Authorization", token).send({ message: "question" });
      await logged.close();
      const frames = res.text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
      return { citations: frames[0].citations, system: anthropic.streamCalls[0].system, queries: logged.queries };
    };

    it("a small user in a crowded index gets their rows, nearest first, with the page text", async () => {
      const exact = await raw.query(
        "select id, title from contents where user_id = $1 order by embedding <=> $2",
        [quiet, JSON.stringify(center)],
      );

      const { citations, system, queries } = await chat(quiet);

      expect(citations.map((c: any) => c.id)).toEqual(exact.rows.map((r) => r.id));
      expect(system).toContain(`Body of ${exact.rows[0].title.toLowerCase()}`);
      expect(queries.join("\n")).not.toContain("hnsw.iterative_scan");
    });

    it("a large user takes the HNSW route and gets 5 citations", async () => {
      const { citations, queries } = await chat(crowded);

      expect(citations).toHaveLength(5);
      expect(queries.join("\n")).toContain("hnsw.iterative_scan");
    });

    it("keeps chat's own 0.25 cutoff", async () => {
      const [row] = await db
        .insert(contents)
        .values({ userId: ada, link: "https://cut", title: "Cutoff row", embedding: vectorNear(900, 0.28, 901) })
        .returning();
      const axis = vectorNear(900, 1);
      const kept = await nearestContents(db, ada, axis, { limit: 5, minSimilarity: 0.25 });
      const dropped = await nearestContents(db, ada, axis, { limit: 5, minSimilarity: 0.3 });
      expect(kept.map((r) => r.id)).toContain(row!.id);
      expect(dropped.map((r) => r.id)).not.toContain(row!.id);
    });
  });

  it("the crowded user still gets a full top 10", async () => {
    const rows = await hybridSearch(db, crowded, "zzznomatch", center, undefined, "vector");
    expect(rows).toHaveLength(10);
  });

  it("hybrid carries the small user's rows through fusion", async () => {
    const rows = await hybridSearch(db, quiet, "zzznomatch", center);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(quietIds));
  });

  it("no planner setting from either route leaks out of the transaction", async () => {
    const value = async (name: string) =>
      Object.values(((await db.execute(sql.raw(`show ${name}`))) as any).rows[0])[0];
    const expectDefaults = async () => {
      expect(await value("hnsw.iterative_scan")).toBe("off");
      for (const name of ["enable_indexscan", "enable_bitmapscan", "enable_seqscan", "enable_sort"]) {
        expect(await value(name)).toBe("on");
      }
    };

    await hybridSearch(db, quiet, "x", center, undefined, "vector");
    await expectDefaults();
    await hybridSearch(db, crowded, "x", center, undefined, "vector");
    await expectDefaults();
  });
});
