// Quality and latency for the three modes, through the production hybridSearch().
//
//   bun --no-env-file run eval/run.ts --label=before
//
// No API calls: query embeddings come from the cache written by eval/ingest.ts,
// and a missing one is an error. Latency is therefore DB + fusion only, without
// the OpenAI call the /search route makes per request.
//
// For each mode the orchestrator restarts Postgres (empty shared_buffers) and
// spawns a fresh Bun process (cold JS), then that child makes RUNS sequential
// passes over all queries. Pass 1 is "first run"; the later passes are "warm".
// macOS keeps its file cache across a Postgres restart and clearing it needs
// sudo, so "first run" is cold for Postgres and Bun but not for the OS.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pg from "pg";
import { createDb, type Db } from "../config/db";
import { contents, users } from "../db/schema";
import { hybridSearch, type HybridSearchTimings, type SearchMode } from "../services/searchService";
import {
  CACHE_DIR, DiskCache, EVAL_DIR, EVAL_USER_EMAIL, RESULTS_DIR, docIdFromLink, embeddingKey,
  evalDatabaseUrl, loadTestQueries,
} from "./lib";
import { mean, mrrAt, ndcgAt, percentile, recallAt } from "./metrics";

const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8);
const K = 10;
const RUNS = 3;
const MODES: SearchMode[] = ["fts", "vector", "hybrid"];

process.env.DRIZZLE_LOGGER = "false";
const databaseUrl = evalDatabaseUrl();
const queries = loadTestQueries();

function loadQueryEmbeddings() {
  const cache = new DiskCache<number[]>("embeddings");
  return new Map(
    queries.map((q) => {
      const v = cache.get(embeddingKey(q.text));
      if (!v) {
        console.error(`Query ${q.id} has no cached embedding. Run eval/ingest.ts first.`);
        process.exit(2);
      }
      return [q.id, v] as const;
    }),
  );
}

async function runMode(mode: SearchMode) {
  const embeddings = loadQueryEmbeddings();
  const db = createDb(databaseUrl) as unknown as Db & { $client: pg.Pool };
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, EVAL_USER_EMAIL));
  if (!user) throw new Error("no eval user: run eval/ingest.ts first");

  // Open the connection first, so the first timed query is not paying for it.
  await db.$client.query("select 1");

  const passes = [];
  for (let pass = 1; pass <= RUNS; pass++) {
    const perQuery = [];
    for (const q of queries) {
      const embedding = mode === "fts" ? null : embeddings.get(q.id)!;
      const timings: HybridSearchTimings = { vectorMs: 0, keywordMs: 0, fusionMs: 0 };
      const t0 = performance.now();
      const rows = await hybridSearch(db, user.id, q.text, embedding, timings, mode);
      const ms = performance.now() - t0;
      const ranked = rows.map((r) => docIdFromLink(r.link as string));
      perQuery.push({
        qid: q.id,
        ms,
        vectorMs: timings.vectorMs,
        keywordMs: timings.keywordMs,
        ranked,
        ndcg: ndcgAt(ranked, q.relevant, K),
        recall: recallAt(ranked, q.relevant, K),
        mrr: mrrAt(ranked, q.relevant, K),
      });
    }
    passes.push(perQuery);
    console.log(`${mode} pass ${pass}: p50 ${percentile(perQuery.map((p) => p.ms), 50).toFixed(2)}ms`);
  }
  await db.$client.end();
  writeFileSync(join(CACHE_DIR, `run-${mode}.json`), JSON.stringify(passes));
}

// Diagnostics on the finished corpus. These SQL strings mirror the vector arm's
// query, they are not the production code path.
async function diagnostics() {
  const embeddings = loadQueryEmbeddings();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const { rows: [{ id: userId }] } = await client.query("select id from users where email = $1", [EVAL_USER_EMAIL]);

  const topK = `select c.link from contents c join users u on c.user_id = u.id
    where c.user_id = $1 order by c.embedding <=> $2 limit ${K}`;
  const planText = (r: pg.QueryResult) => r.rows.map((x) => x["QUERY PLAN"]).join("\n");
  const sample = JSON.stringify(embeddings.get(queries[0]!.id));

  const planDefault = planText(await client.query(`explain ${topK}`, [userId, sample]));
  await client.query("begin; set local enable_seqscan = off");
  const planOverride = planText(await client.query(`explain ${topK}`, [userId, sample]));
  await client.query("rollback");

  // How much top-10 does HNSW (ef_search default) lose against an exact scan?
  // Exact search is forced by turning index scans off for the transaction.
  const overlaps: number[] = [];
  for (const q of queries) {
    const vector = JSON.stringify(embeddings.get(q.id));
    await client.query("begin; set local enable_seqscan = off; set local enable_bitmapscan = off; set local enable_sort = off");
    const ann = await client.query(topK, [userId, vector]);
    await client.query("rollback");
    await client.query("begin; set local enable_indexscan = off; set local enable_bitmapscan = off");
    const exact = await client.query(topK, [userId, vector]);
    await client.query("rollback");
    const exactSet = new Set(exact.rows.map((r) => r.link));
    overlaps.push(ann.rows.filter((r) => exactSet.has(r.link)).length / K);
  }

  const ef = (await client.query("show hnsw.ef_search")).rows[0]["hnsw.ef_search"];
  const server = (await client.query("show server_version")).rows[0].server_version;
  const pgvector = (await client.query("select extversion from pg_extension where extname = 'vector'")).rows[0].extversion;
  const shared = (await client.query("show shared_buffers")).rows[0].shared_buffers;
  const count = (await client.query("select count(*)::int as n from contents")).rows[0].n;
  await client.end();

  return {
    planDefault,
    planOverride,
    annVsExactTop10Overlap: mean(overlaps),
    efSearch: ef,
    server,
    pgvector,
    sharedBuffers: shared,
    corpusRows: count,
  };
}

function summarize(sample: number[]) {
  return { p50: percentile(sample, 50), p95: percentile(sample, 95), n: sample.length };
}

async function orchestrate() {
  const services = join(EVAL_DIR, "local-services.sh");
  const results: Record<string, any> = {};

  for (const mode of MODES) {
    execFileSync(services, ["stop"], { stdio: "ignore" });
    execFileSync(services, ["start"], { stdio: "ignore" });
    const child = spawnSync("bun", ["--no-env-file", "run", join(EVAL_DIR, "run.ts"), `--mode=${mode}`], {
      stdio: "inherit",
    });
    if (child.status !== 0) process.exit(child.status ?? 1);

    const passes = JSON.parse(readFileSync(join(CACHE_DIR, `run-${mode}.json`), "utf8")) as any[][];
    const last = passes[passes.length - 1]!;

    // Ranked lists should be stable between passes; record it if they are not.
    const unstable = last.filter(
      (q, i) => passes.some((p) => JSON.stringify(p[i].ranked) !== JSON.stringify(q.ranked)),
    ).length;

    results[mode] = {
      ndcg: mean(last.map((q) => q.ndcg)),
      recall: mean(last.map((q) => q.recall)),
      mrr: mean(last.map((q) => q.mrr)),
      queriesWithChangedRankingBetweenPasses: unstable,
      queriesWithNoResults: last.filter((q) => q.ranked.length === 0).length,
      meanResults: mean(last.map((q) => q.ranked.length)),
      latencyByPass: passes.map((p) => summarize(p.map((q) => q.ms))),
      latencyFirstRun: summarize(passes[0]!.map((q) => q.ms)),
      latencyWarm: summarize(passes.slice(1).flat().map((q) => q.ms)),
      warmVectorArmP50: percentile(passes.slice(1).flat().map((q) => q.vectorMs), 50),
      warmKeywordArmP50: percentile(passes.slice(1).flat().map((q) => q.keywordMs), 50),
      perQuery: last.map((q) => ({ qid: q.qid, ndcg: q.ndcg, n: q.ranked.length })),
    };
  }

  // Hybrid vs vector, per query.
  const byQid = new Map(results.vector.perQuery.map((q: any) => [q.qid, q.ndcg]));
  const comparison = { wins: 0, losses: 0, ties: 0 };
  for (const q of results.hybrid.perQuery) {
    const v = byQid.get(q.qid) as number;
    if (q.ndcg > v + 1e-12) comparison.wins++;
    else if (q.ndcg < v - 1e-12) comparison.losses++;
    else comparison.ties++;
  }

  const output = {
    label,
    generatedAt: new Date().toISOString(),
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    k: K,
    runsPerMode: RUNS,
    queries: queries.length,
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGb: Math.round(totalmem() / 2 ** 30) },
    diagnostics: await diagnostics(),
    hybridVsVectorNdcg: comparison,
    modes: results,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `results-${label}.json`), JSON.stringify(output, null, 2) + "\n");
  console.log(`wrote results-${label}.json`);
}

const modeArg = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) as SearchMode | undefined;
if (!modeArg && !label) {
  console.error("usage: eval/run.ts --label=before|after");
  process.exit(2);
}
if (modeArg) {
  await runMode(modeArg);
} else {
  await orchestrate();
}
