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

  it("with the override, the plan uses the HNSW index", async () => {
    await raw.query("begin; set local enable_seqscan = off");
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
  beforeAll(async () => {
    // `crowded` owns many rows closer to the query than anything `quiet` owns.
    await db.insert(contents).values(
      Array.from({ length: 300 }, (_, i) => ({
        userId: crowded,
        link: `https://crowded/${i}`,
        title: `Crowded ${i}`,
        embedding: vectorNear(100, 0.99, 200 + i),
      })),
    );
    await db.insert(contents).values(
      Array.from({ length: 5 }, (_, i) => ({
        userId: quiet,
        link: `https://quiet/${i}`,
        title: `Quiet ${i}`,
        embedding: vectorNear(100, 0.7, 600 + i),
      })),
    );
    await raw.query("analyze contents");
  });

  it("KNOWN BUG: post-filtering hides a user's rows when other tenants crowd the neighbourhood", async () => {
    // `quiet` owns 5 rows at similarity 0.7, well above the 0.3 cutoff, and an
    // exact search finds all 5. The index returns ef_search=40 candidates, all
    // owned by `crowded`, and then the user_id filter removes them.
    const axis100 = vectorNear(100, 1);
    const exact = await raw.query(
      `select count(*)::int as n from contents
       where user_id = $1 and 1 - (embedding <=> $2) > 0.3`,
      [quiet, JSON.stringify(axis100)],
    );
    expect(exact.rows[0].n).toBe(5);

    const rows = await hybridSearch(db, quiet, "zzznomatch", axis100, undefined, "vector");
    expect(rows.length).toBeLessThan(5);
  });
});
