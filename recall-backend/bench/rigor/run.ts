// Rigor benchmark runner — measures arms A–E against a seeded bench DB.
//
//   bun run bench/rigor/run.ts --scale=10000                 # all arms A-E
//   bun run bench/rigor/run.ts --scale=1000  --arms=A,C      # scaling arms
//   bun run bench/rigor/run.ts --scale=50000 --arms=A,C
//
// Arms (vector query mirrors services/searchService.ts exactly: same
// projection, users join, user_id filter, ORDER BY embedding <=> $q, LIMIT 10):
//   A  sequential scan forced:  SET LOCAL enable_indexscan=off, enable_bitmapscan=off
//   B  default planner, no overrides
//   C  the app's scoped override: transaction + SET LOCAL enable_seqscan=off
//   D  lexical arm alone — Postgres FTS: search_vector @@ websearch_to_tsquery,
//      ORDER BY ts_rank, GIN index available (whether the planner uses it is
//      captured honestly in the EXPLAIN, not forced)
//   E  full hybrid path end-to-end at the app layer: the real hybridSearch()
//      (C-style vector arm + D FTS + RRF in JS), measured around the call
//
// Protocol: explicit warm pass (full 200-query set once, discarded), then
// 3 measured rounds x 200 queries per arm; client-side wall time per query.
// Arms A and C include their BEGIN/SET LOCAL/COMMIT round-trips in the
// measured time because the app pays the same (db.transaction + set local).
// Recall pass: top-10 ids from A (exact) vs B and C, recall@10 per query.
// EXPLAIN (ANALYZE, BUFFERS) captured once per arm for query #0.

import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { execSync } from "node:child_process";
import pg from "pg";
import { DIM, requireSafeDatabaseUrl, vectorLiteral } from "../shared";
import { N_QUERIES, benchDbUrl, queryEmbedding, textQueries } from "./gen";

const { Client } = pg;

const ROUNDS = 3;
const LIMIT = 10;

function parseArgs() {
  const a = process.argv.slice(2);
  const val = (n: string) => a.find((x) => x.startsWith(`--${n}=`))?.split("=")[1];
  return {
    scale: parseInt(val("scale") ?? "10000", 10),
    arms: (val("arms") ?? "A,B,C,D,E").split(",").map((s) => s.trim().toUpperCase()),
  };
}

// Same projection as searchService.ts baseFields (+ similarity).
const PROJ = `
  c.id, c.title, c.link, c.type, c.tags, c.og_title, c.og_description,
  c.og_image, c.og_site_name, c.favicon, c.embed_url, c.summary,
  c.processing_status, c.created_at, u.username`;

const VEC_SQL = `
  select ${PROJ}, 1 - (c.embedding <=> $1::vector) as similarity
  from contents c
  inner join users u on c.user_id = u.id
  where c.user_id = $2
  order by c.embedding <=> $1::vector asc
  limit ${LIMIT}`;

// Mirrors the app's FTS lexical arm (searchService.ts): websearch_to_tsquery
// appears three times in the text but is IMMUTABLE with an explicit config, so
// the planner folds it to one tsquery constant (visible in the captured
// EXPLAIN). numnode guard = the app's empty/stopword-query fallback.
const FTS_SQL = `
  select ${PROJ}
  from contents c
  inner join users u on c.user_id = u.id
  where c.user_id = $2
    and (numnode(websearch_to_tsquery('english', $1)) = 0
         or c.search_vector @@ websearch_to_tsquery('english', $1))
  order by ts_rank(c.search_vector, websearch_to_tsquery('english', $1)) desc
  limit ${LIMIT}`;

type ArmName = "A" | "B" | "C" | "D" | "E";

// SET LOCAL statements per arm (empty = no transaction wrapper, like the app's
// keyword query and the default-planner arm).
const ARM_SETTINGS: Record<string, string[]> = {
  A: ["set local enable_indexscan = off", "set local enable_bitmapscan = off"],
  B: [],
  C: ["set local enable_seqscan = off"],
  D: [],
};

async function runArmQuery(
  c: pg.Client, arm: ArmName, params: any[],
): Promise<{ ms: number; ids: string[] }> {
  const sqlText = arm === "D" ? FTS_SQL : VEC_SQL;
  const settings = ARM_SETTINGS[arm]!;
  const t0 = performance.now();
  let rows: any[];
  if (settings.length) {
    await c.query("begin");
    for (const s of settings) await c.query(s);
    rows = (await c.query(sqlText, params)).rows;
    await c.query("commit");
  } else {
    rows = (await c.query(sqlText, params)).rows;
  }
  return { ms: performance.now() - t0, ids: rows.map((r) => r.id) };
}

async function explainArm(c: pg.Client, arm: ArmName, params: any[]): Promise<string> {
  const sqlText = `explain (analyze, buffers) ${arm === "D" ? FTS_SQL : VEC_SQL}`;
  const settings = ARM_SETTINGS[arm]!;
  await c.query("begin");
  for (const s of settings) await c.query(s);
  const rows = (await c.query(sqlText, params)).rows;
  await c.query("commit");
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

async function main() {
  const { scale, arms } = parseArgs();
  const { url: baseUrl } = requireSafeDatabaseUrl();
  const dbUrl = benchDbUrl(baseUrl, scale);

  // Point the app's db module at the bench DB BEFORE importing it (arm E runs
  // the real hybridSearch). Shell env wins over .env in Bun, and this runs
  // before the dynamic import below evaluates config/db.ts.
  process.env.DATABASE_URL = dbUrl;
  process.env.DRIZZLE_LOGGER = "false";

  const sha = execSync("git rev-parse --short HEAD").toString().trim();
  const outDir = `bench/results/${sha}`;
  mkdirSync(`${outDir}/explain`, { recursive: true });
  mkdirSync(`${outDir}/raw`, { recursive: true });

  const c = new Client({ connectionString: dbUrl });
  await c.connect();

  const meta = {
    scale,
    sha,
    // Dirty means uncommitted CODE — the bench's own untracked output under
    // bench/results/ must not count, or every run would mark itself dirty.
    dirty: execSync("git status --porcelain").toString().split("\n")
      .some((l) => l.trim() && !l.includes("bench/results")),
    pg: (await c.query("select version()")).rows[0].version as string,
    pgvector: (await c.query("select extversion from pg_extension where extname='vector'"))
      .rows[0].extversion as string,
    rows: (await c.query("select count(*)::int n from contents where embedding is not null"))
      .rows[0].n as number,
    indexdef: (await c.query(
      "select indexdef from pg_indexes where indexname='idx_contents_embedding_hnsw'",
    )).rows[0]?.indexdef as string,
    ef_search: (await c.query("select current_setting('hnsw.ef_search') as v")).rows[0].v as string,
    rounds: ROUNDS,
    queries: N_QUERIES,
    date: new Date().toISOString(),
  };
  console.log(`rigor run: scale=${scale} arms=${arms.join(",")} sha=${sha}${meta.dirty ? " (dirty tree)" : ""}`);
  console.log(`  ${meta.pg}`);
  console.log(`  pgvector ${meta.pgvector} | rows ${meta.rows} | hnsw.ef_search ${meta.ef_search}`);
  if (!meta.indexdef) throw new Error("HNSW index missing — reseed");

  const userId: string = (await c.query("select id from users limit 1")).rows[0].id;
  const qvecs = Array.from({ length: N_QUERIES }, (_, j) => vectorLiteral(queryEmbedding(j)));
  const qtexts = textQueries(); // raw query text — websearch_to_tsquery does its own parsing

  const paramsFor = (arm: ArmName, j: number) =>
    arm === "D" ? [qtexts[j], userId] : [qvecs[j], userId];

  const results: Record<string, any> = { meta };

  // ---- arms A-D: raw SQL on one dedicated connection ------------------------
  for (const arm of arms.filter((x) => x !== "E") as ArmName[]) {
    // explicit warm pass: full query set once, discarded
    for (let j = 0; j < N_QUERIES; j++) await runArmQuery(c, arm, paramsFor(arm, j));
    const samples: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (let j = 0; j < N_QUERIES; j++) {
        samples.push((await runArmQuery(c, arm, paramsFor(arm, j))).ms);
      }
      process.stdout.write(`\rarm ${arm}: round ${r + 1}/${ROUNDS} done   `);
    }
    console.log();
    results[arm] = { samples };
    // FTS tokenization check: the 200 fixed text queries were designed for
    // ILIKE substring matching; verify they still produce hits under
    // websearch_to_tsquery AND-semantics (phrases are seeded verbatim into
    // title/summary, so stemming applies to both sides).
    if (arm === "D") {
      let hits = 0;
      for (let j = 0; j < N_QUERIES; j++) {
        if ((await runArmQuery(c, "D", paramsFor("D", j))).ids.length > 0) hits++;
      }
      results.D.hitRate = hits / N_QUERIES;
      console.log(`arm D: ${hits}/${N_QUERIES} text queries returned >=1 row`);
    }
    const plan = await explainArm(c, arm, paramsFor(arm, 0));
    writeFileSync(`${outDir}/explain/arm${arm}_scale${scale}.txt`,
      `-- arm ${arm}, scale ${scale}, query #0, settings: ${ARM_SETTINGS[arm]!.join("; ") || "(none — default planner)"}\n${plan}\n`);
  }

  // ---- recall@10: A (forced seq scan = exact) is ground truth ---------------
  if (arms.includes("A") && (arms.includes("B") || arms.includes("C"))) {
    const recall: Record<string, number[]> = { B: [], C: [] };
    for (let j = 0; j < N_QUERIES; j++) {
      const truth = new Set((await runArmQuery(c, "A", paramsFor("A", j))).ids);
      for (const arm of ["B", "C"] as const) {
        if (!arms.includes(arm)) continue;
        const got = (await runArmQuery(c, arm, paramsFor(arm, j))).ids;
        recall[arm]!.push(got.filter((id) => truth.has(id)).length / truth.size);
      }
    }
    for (const arm of ["B", "C"] as const) {
      if (recall[arm]!.length) {
        results[arm].recallAt10 = recall[arm]!.reduce((a, b) => a + b, 0) / recall[arm]!.length;
        console.log(`recall@10 ${arm} vs A: ${results[arm].recallAt10.toFixed(4)}`);
      }
    }
  }

  // ---- arm E: real hybridSearch() at the application layer ------------------
  if (arms.includes("E")) {
    const { hybridSearch } = await import("../../services/searchService");
    const embeds = Array.from({ length: N_QUERIES }, (_, j) => queryEmbedding(j));
    const texts = textQueries();
    const doOne = async (j: number) => {
      const t = { vectorMs: 0, keywordMs: 0, fusionMs: 0 };
      const t0 = performance.now();
      await hybridSearch(userId, texts[j]!, embeds[j]!, t);
      return { ms: performance.now() - t0, t };
    };
    for (let j = 0; j < N_QUERIES; j++) await doOne(j); // warm pass, discarded
    const samples: number[] = [];
    const phases = { vector: [] as number[], keyword: [] as number[], fusion: [] as number[] };
    for (let r = 0; r < ROUNDS; r++) {
      for (let j = 0; j < N_QUERIES; j++) {
        const s = await doOne(j);
        samples.push(s.ms);
        phases.vector.push(s.t.vectorMs);
        phases.keyword.push(s.t.keywordMs);
        phases.fusion.push(s.t.fusionMs);
      }
      process.stdout.write(`\rarm E: round ${r + 1}/${ROUNDS} done   `);
    }
    console.log();
    results.E = { samples, phases };
    writeFileSync(`${outDir}/explain/armE_scale${scale}.txt`,
      "-- arm E is the application-layer hybrid path (services/searchService.ts hybridSearch):\n" +
      "--   vector arm = transaction + SET LOCAL enable_seqscan=off (same plan as armC_*.txt)\n" +
      "--   lexical arm = FTS query (same plan as armD_*.txt)\n" +
      "--   fusion = Reciprocal Rank Fusion (k=60) in JS — no SQL, nothing to EXPLAIN\n" +
      "-- Timed at the app layer around hybridSearch(); see raw JSON `phases` for per-phase ms.\n");
    const { db } = await import("../../config/db");
    await (db.$client as any)?.end?.();
  }

  writeFileSync(`${outDir}/raw/scale${scale}.json`, JSON.stringify(results, null, 1));
  console.log(`wrote ${outDir}/raw/scale${scale}.json`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
