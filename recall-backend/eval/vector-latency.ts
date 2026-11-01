// Seq scan vs HNSW for the vector arm, with result correctness measured next to
// latency: a fast index scan that returns the wrong rows is not a win.
//
//   bun --no-env-file run eval/vector-latency.ts --label=before
//
// Uses the SciFact corpus and the 300 test-query embeddings. Three tenants share
// one table and one HNSW index, in a clone of recall_eval:
//   whole : the eval database as ingested, one user owning every row
//   medium: a user owning about 20% of the rows, the rest owned by another user
//   tiny  : a user owning about 1% of the rows, same setup
//
// Arms:
//   exact             seq scan forced (index scans off). Ground truth.
//   production        hybridSearch(mode "vector"), the code as it is at this commit.
//   hnsw-40-override  HNSW, ef_search 40, override on, no iterative scan (the old path).
//   iterative-no-override  iterative scan on, enable_seqscan left alone: what the
//                     planner picks if the override is removed.
//
// Every arm applies the same 0.3 similarity cutoff. "correct" is the share of the
// exact top-10 that the arm returned, averaged over queries with non-empty truth.
// One warm-up pass per arm is discarded, then 3 timed passes are pooled.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { createDb, type Db } from "../config/db";
import { hybridSearch } from "../services/searchService";
import { DiskCache, EVAL_USER_EMAIL, RESULTS_DIR, embeddingKey, evalDatabaseUrl, loadTestQueries } from "./lib";
import { mean, percentile } from "./metrics";

process.env.DRIZZLE_LOGGER = "false";
const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8);
if (!label) {
  console.error("usage: eval/vector-latency.ts --label=before|after");
  process.exit(2);
}

const K = 10;
const PASSES = 3;
const CLONE = "recall_eval_tenants";
const evalUrl = evalDatabaseUrl();
const cloneUrl = evalUrl.replace(/\/[^/]*$/, `/${CLONE}`);
const queries = loadTestQueries();
const cache = new DiskCache<number[]>("embeddings");
const vectors = queries.map((q) => {
  const v = cache.get(embeddingKey(q.text));
  if (!v) throw new Error(`no cached embedding for query ${q.id}: run eval/ingest.ts first`);
  return v;
});

// Same joined projection width as the production query, so exact is not flattered.
const SELECT = `select c.id, c.title, c.link, c.type, c.tags, c.og_title, c.og_description, c.og_image,
    c.og_site_name, c.favicon, c.embed_url, c.summary, c.processing_status, c.created_at, u.username,
    1 - (c.embedding <=> $2) as similarity
  from contents c join users u on c.user_id = u.id
  where c.user_id = $1 order by c.embedding <=> $2 limit ${K}`;

async function buildClone() {
  const admin = new pg.Client({ connectionString: evalUrl.replace(/\/[^/]*$/, "/postgres") });
  await admin.connect();
  await admin.query(`drop database if exists ${CLONE}`);
  await admin.query(`create database ${CLONE} template recall_eval`);
  await admin.end();

  const c = new pg.Client({ connectionString: cloneUrl });
  await c.connect();
  const ids: Record<string, string> = {};
  for (const name of ["tiny", "medium"]) {
    const r = await c.query(
      `insert into users (username, email, password) values ($1, $2, 'x') returning id`,
      [name, `${name}@scifact.example`],
    );
    ids[name] = r.rows[0].id;
  }
  // md5 of the link, so the split is deterministic.
  const bucket = `(('x' || substr(md5(link), 1, 8))::bit(32)::bigint % 100)`;
  await c.query(`update contents set user_id = $1 where ${bucket} = 0`, [ids.tiny]);
  await c.query(`update contents set user_id = $1 where ${bucket} between 1 and 20`, [ids.medium]);
  await c.query("vacuum analyze contents");
  const counts = await c.query("select u.username, count(*)::int as n from contents c join users u on u.id = c.user_id group by 1");
  await c.end();
  return { ids, counts: Object.fromEntries(counts.rows.map((r) => [r.username, r.n])) };
}

type Arm = (userId: string, vector: number[]) => Promise<string[]>;

function rawArm(client: pg.Client, settings: string): Arm {
  return async (userId, vector) => {
    await client.query(`begin; ${settings}`);
    const r = await client.query(SELECT, [userId, JSON.stringify(vector)]);
    await client.query("rollback");
    return r.rows.filter((x) => x.similarity > 0.3).map((x) => x.link);
  };
}

async function measure(arm: Arm, userId: string, truth: string[][]) {
  for (const v of vectors) await arm(userId, v); // warm-up, discarded

  const ms: number[] = [];
  let last: string[][] = [];
  for (let pass = 0; pass < PASSES; pass++) {
    last = [];
    for (const v of vectors) {
      const t0 = performance.now();
      const links = await arm(userId, v);
      ms.push(performance.now() - t0);
      last.push(links);
    }
  }

  const scored = truth.flatMap((t, i) => {
    if (t.length === 0) return [];
    const got = new Set(last[i]);
    return [t.filter((link) => got.has(link)).length / t.length];
  });
  const orderExact = truth.filter((t, i) => JSON.stringify(t) === JSON.stringify(last[i])).length;
  return {
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    correctShareOfExactTop10: scored.length ? mean(scored) : null,
    queriesWithExactSameList: orderExact,
    meanRowsReturned: mean(last.map((l) => l.length)),
    samples: ms.length,
  };
}

async function runTenant(url: string, userId: string) {
  const raw = new pg.Client({ connectionString: url });
  await raw.connect();
  const db = createDb(url) as unknown as Db & { $client: pg.Pool };

  const exactSettings = "set local enable_indexscan = off; set local enable_bitmapscan = off";
  const exact = rawArm(raw, exactSettings);
  const truth: string[][] = [];
  for (const v of vectors) truth.push(await exact(userId, v));

  const production: Arm = async (u, v) =>
    (await hybridSearch(db, u, "", v, undefined, "vector")).map((r) => r.link as string);

  const arms: Record<string, Arm> = {
    exact,
    production,
    "hnsw-40-override": rawArm(raw, "set local enable_seqscan = off; set local hnsw.iterative_scan = off"),
    "iterative-no-override": rawArm(raw, "set local hnsw.iterative_scan = strict_order"),
  };

  const out: Record<string, any> = { queriesWithAnyTruth: truth.filter((t) => t.length).length };
  for (const [name, arm] of Object.entries(arms)) {
    out[name] = await measure(arm, userId, truth);
    console.log(name, JSON.stringify(out[name]));
  }

  // Which plan does each setting give? (first test query)
  const plan = async (settings: string) => {
    await raw.query(`begin; ${settings}`);
    const r = await raw.query(`explain ${SELECT}`, [userId, JSON.stringify(vectors[0])]);
    await raw.query("rollback");
    return r.rows.map((x) => x["QUERY PLAN"]).filter((l: string) => /Scan|Sort/.test(l)).map((l: string) => l.trim().replace(/\(cost.*$/, "")).join(" | ");
  };
  out.planDefault = await plan("select 1");
  out.planOverride = await plan("set local enable_seqscan = off");
  out.planIterativeNoOverride = await plan("set local hnsw.iterative_scan = strict_order");

  await db.$client.end();
  await raw.end();
  return out;
}

const { ids, counts } = await buildClone();

const c = new pg.Client({ connectionString: evalUrl });
await c.connect();
const wholeId = (await c.query("select id from users where email = $1", [EVAL_USER_EMAIL])).rows[0].id;
const corpusRows = (await c.query("select count(*)::int as n from contents")).rows[0].n;
await c.end();

const tenants: Record<string, any> = {};
for (const [name, url, id] of [
  ["whole", evalUrl, wholeId],
  ["medium", cloneUrl, ids.medium!],
  ["tiny", cloneUrl, ids.tiny!],
] as const) {
  console.log(`--- ${name}`);
  tenants[name] = await runTenant(url, id);
}

mkdirSync(RESULTS_DIR, { recursive: true });
const output = {
  label,
  generatedAt: new Date().toISOString(),
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  corpusRows,
  rowsByTenantInClone: counts,
  queries: queries.length,
  passes: PASSES,
  tenants,
};
const path = join(RESULTS_DIR, `vector-latency-${label}.json`);
writeFileSync(path, JSON.stringify(output, null, 2) + "\n");
console.log(`wrote ${path}`);
