// Real Postgres + pgvector (eval/local-services.sh start), real node-postgres
// driver, real HNSW and GIN indexes. Vectors are hand-built with known cosines.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type pg from "pg";
import type { Db } from "../config/db";
import { contents, users } from "../db/schema";
import { hybridSearch } from "../services/searchService";
import { freshDatabase, vectorNear } from "./pg";

let db: Db;
let raw: pg.Client;
let close: () => Promise<void>;
let ada: string;
let grace: string;
let crowded: string;
let quiet: string;

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
    await raw.query("begin; set local enable_seqscan = off; set local hnsw.iterative_scan = relaxed_order");
    const { rows } = await raw.query(
      `explain select c.id from contents c join users u on c.user_id = u.id
       where c.user_id = $1 order by c.embedding <=> $2 limit 10`,
      [ada, JSON.stringify(query)],
    );
    await raw.query("rollback");
    expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("idx_contents_embedding_hnsw");
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

  it("KNOWN LIMITATION: every term is ANDed, one unmatched word returns nothing", async () => {
    const rows = await hybridSearch(db, ada, "graphene conductivity measurements", null, undefined, "fts");
    expect(rows).toEqual([]);
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
    const rows = Array.from({ length: 400 }, (_, i) => {
      const spread = 0.01 + 0.03 * (i / 400);
      const embedding = normalize(center.map((x) => x + spread * gaussian()));
      return { embedding, sim: dot(embedding, center), i };
    }).sort((a, b) => b.sim - a.sim);

    // The nearest 300 are the crowd; `quiet` gets 5 from the far end, all well
    // above the 0.3 cutoff, and `midling` the next 20. Inserted in the original,
    // unsorted order.
    const owner = (rank: number) => (rank < 300 ? crowded : rank < 305 ? quiet : rank < 325 ? midling : grace);
    const values = rows
      .map((r, rank) => ({
        i: r.i,
        userId: owner(rank),
        link: `https://tenant/${r.i}`,
        title: `Tenant row ${r.i}`,
        embedding: r.embedding,
      }))
      .sort((a, b) => a.i - b.i)
      .map(({ i: _i, ...v }) => v);
    await db.insert(contents).values(values);
    await raw.query("analyze contents");
    quietIds = (await raw.query("select id from contents where user_id = $1", [quiet])).rows.map((r) => r.id);
  });

  it("the fixture reproduces the bug: without the iterative scan, the small user gets nothing", async () => {
    await raw.query("begin; set local enable_seqscan = off; set local hnsw.iterative_scan = off");
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

  it("regression: the iterative scan fills the top 10 for a user the old path left empty", async () => {
    await raw.query("begin; set local enable_seqscan = off; set local hnsw.iterative_scan = off");
    const old = await raw.query(
      "select id from contents where user_id = $1 order by embedding <=> $2 limit 10",
      [midling, JSON.stringify(center)],
    );
    await raw.query("rollback");
    expect(old.rows.length).toBeLessThan(10);

    const rows = await hybridSearch(db, midling, "zzznomatch", center, undefined, "vector");
    expect(rows).toHaveLength(10);
    const sims = rows.map((r) => r.similarity as number);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
  });

  it("the crowded user still gets a full top 10", async () => {
    const rows = await hybridSearch(db, crowded, "zzznomatch", center, undefined, "vector");
    expect(rows).toHaveLength(10);
  });

  it("hybrid carries the small user's rows through fusion", async () => {
    const rows = await hybridSearch(db, quiet, "zzznomatch", center);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(quietIds));
  });

  it("neither the iterative scan nor the fallback's settings leak out of the transaction", async () => {
    // `quiet` has fewer than 10 rows, so this takes the exact fallback.
    await hybridSearch(db, quiet, "x", center, undefined, "vector");
    const value = async (name: string) =>
      Object.values(((await db.execute(sql.raw(`show ${name}`))) as any).rows[0])[0];
    expect(await value("hnsw.iterative_scan")).toBe("off");
    expect(await value("enable_indexscan")).toBe("on");
    expect(await value("enable_bitmapscan")).toBe("on");
    expect(await value("enable_seqscan")).toBe("on");
  });
});
