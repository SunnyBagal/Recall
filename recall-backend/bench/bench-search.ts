// Hybrid-search latency benchmark.
//
//   cd recall-backend
//   # end-to-end (default): hits the running API's GET /api/v1/search, which
//   # embeds the query LIVE via OpenAI per request. Requires the API running.
//   bun run bench/bench-search.ts
//
//   # retrieval-only: precompute the 20 query embeddings ONCE (cached to
//   # bench/query-embeddings.json), then time ONLY the retrieval path
//   # (pgvector + ILIKE + RRF) by calling the real hybridSearch() directly.
//   bun run bench/bench-search.ts --retrieval-only
//
//   # options: --concurrency=10  --measured=500  --warmup=50  --api=http://localhost:3000
//
// Protocol: 50 warmup (discarded) + 500 measured, 20 rotating queries.
// Percentiles are nearest-rank from raw samples (no averaging buckets).

import "./quiet"; // MUST be first: sets DRIZZLE_LOGGER=false before ../config/db loads
import { performance } from "node:perf_hooks";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "../config/db";
import { hybridSearch, type HybridSearchTimings } from "../services/searchService";
import { generateEmbedding } from "../services/embeddings";
import {
  BENCH_USER,
  DEFAULT_API_URL,
  DIM,
  QUERIES,
  isLocalDatabase,
  percentile,
  requireSafeDatabaseUrl,
  seededUnitVector,
  vectorLiteral,
} from "./shared";

interface Sample {
  ms: number;
  ok: boolean;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const num = (name: string, def: number) => {
    const f = a.find((x) => x.startsWith(`--${name}=`));
    return f ? parseInt(f.split("=")[1] ?? "", 10) : def;
  };
  const str = (name: string, def: string) => {
    const f = a.find((x) => x.startsWith(`--${name}=`));
    return f ? (f.split("=")[1] ?? def) : def;
  };
  return {
    retrievalOnly: a.includes("--retrieval-only"),
    concurrency: num("concurrency", 1),
    measured: num("measured", 500),
    warmup: num("warmup", 50),
    apiUrl: str("api", DEFAULT_API_URL),
  };
}

async function getMeta() {
  const idx = (
    await db.execute(sql`select indexname, indexdef from pg_indexes where tablename = 'contents'`)
  ).rows as any[];
  const total = ((await db.execute(sql`select count(*)::int as n from contents`)).rows[0] as any).n;
  const withEmbedding = (
    (await db.execute(sql`select count(*)::int as n from contents where embedding is not null`))
      .rows[0] as any
  ).n;

  const hnsw = idx.find((r) => /USING hnsw/i.test(r.indexdef));
  const ivf = idx.find((r) => /USING ivfflat/i.test(r.indexdef));
  const indexType = hnsw ? "hnsw (vector_cosine_ops)" : ivf ? "ivfflat" : "none (sequential scan on embedding)";
  return { indexType, indexdef: hnsw?.indexdef ?? ivf?.indexdef ?? null, total, withEmbedding };
}

async function getBenchUserId(): Promise<string> {
  const r = (await db.execute(sql`select id from users where email = ${BENCH_USER.email} limit 1`))
    .rows as any[];
  if (!r.length) {
    throw new Error("Bench user not found — run the seed first: bun run bench/seed-vectors.ts");
  }
  return r[0].id;
}

/**
 * EXPLAIN ANALYZE the bench's exact vector-arm query and report whether the
 * planner uses the HNSW index. Mirrors the vector arm of
 * services/searchService.ts: clean top-k (no distance predicate in SQL),
 * `ORDER BY embedding <=> $vec ASC LIMIT`, run inside a transaction with
 * `SET LOCAL enable_seqscan = off` (pgvector under-costs HNSW at this table
 * size). The vector is a bound param so the plan text stays compact.
 */
async function verifyHnswUsage(userId: string) {
  const vec = vectorLiteral(seededUnitVector(QUERIES[0]!, DIM));
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    return (
      await tx.execute(sql`
        explain (analyze, costs off)
        select c.id, 1 - (c.embedding <=> ${vec}::vector) as similarity
        from contents c
        inner join users u on c.user_id = u.id
        where c.user_id = ${userId}
        order by c.embedding <=> ${vec}::vector asc
        limit 10
      `)
    ).rows as any[];
  });

  const plan = rows.map((r) => String(r["QUERY PLAN"])).join("\n");
  const usesHnsw = /Index Scan using idx_contents_embedding_hnsw/i.test(plan);
  // First scan node on `contents`, vector literals defensively stripped.
  const scanLine =
    plan
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /Scan/.test(l) && /contents/i.test(l))
      ?.replace(/'?\[[-0-9.,e ]{40,}\]'?(::vector)?/g, "<vec>") ?? "(no scan node found)";
  return { usesHnsw, scanLine };
}

async function getToken(apiUrl: string): Promise<string> {
  // Create the user if missing (409 if the seed already made it), then sign in.
  await fetch(`${apiUrl}/api/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(BENCH_USER),
  }).catch(() => {});
  const res = await fetch(`${apiUrl}/api/v1/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: BENCH_USER.email, password: BENCH_USER.password }),
  });
  if (!res.ok) throw new Error(`/signin failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as any;
  if (!j.token) throw new Error("no token in /signin response");
  // NOTE: authMiddleware expects the BARE token in Authorization (no "Bearer ").
  return j.token as string;
}

const CACHE_PATH = fileURLToPath(new URL("./query-embeddings.json", import.meta.url));

interface EmbeddingCache {
  synthetic: boolean;
  model: string;
  embeddings: Record<string, number[]>;
}

/**
 * Query embeddings for retrieval-only mode. Prefers a real OpenAI embedding
 * (cached to disk so re-runs cost 0 API calls). If OPENAI_API_KEY is missing OR
 * the embedding call fails, falls back to DETERMINISTIC synthetic vectors: a
 * mulberry32 PRNG seeded from each query string, so re-runs are identical.
 *
 * For a LATENCY benchmark this is equivalent — the pgvector scan / HNSW
 * traversal does the same work over any 1536-d unit vector. It would only be
 * wrong for a recall/quality benchmark, which this explicitly is not.
 */
async function loadQueryEmbeddings(): Promise<{ embeddings: Record<string, number[]>; synthetic: boolean }> {
  // Reuse an existing cache if it already covers every query.
  if (existsSync(CACHE_PATH)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as EmbeddingCache;
      if (cached?.embeddings && QUERIES.every((q) => Array.isArray(cached.embeddings[q]))) {
        return { embeddings: cached.embeddings, synthetic: !!cached.synthetic };
      }
    } catch {
      /* corrupt/old cache — rebuild below */
    }
  }

  const embeddings: Record<string, number[]> = {};
  let synthetic = false;
  for (const q of QUERIES) {
    let e: number[] | null = null;
    try {
      e = await generateEmbedding(q); // null if OPENAI_API_KEY unset
    } catch {
      e = null; // network/credit/API failure
    }
    if (!e) {
      synthetic = true;
      break;
    }
    embeddings[q] = e;
  }

  if (synthetic) {
    // Deterministic per-query synthetic vectors (seed derived from the query).
    for (const q of QUERIES) embeddings[q] = seededUnitVector(q, DIM);
  }

  const out: EmbeddingCache = {
    synthetic,
    model: synthetic ? "synthetic:mulberry32-unit-vector" : "openai:text-embedding-3-small",
    embeddings,
  };
  writeFileSync(CACHE_PATH, JSON.stringify(out));
  return { embeddings, synthetic };
}

// Rotating-query worker pool. concurrency=1 => strictly sequential.
async function runPool(count: number, concurrency: number, doOne: (q: string) => Promise<Sample>) {
  const samples: number[] = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= count) break;
      const s = await doOne(QUERIES[i % QUERIES.length]!);
      samples.push(s.ms);
      if (!s.ok) errors++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { samples, errors };
}

function report(label: string, samples: number[], errors: number, wallMs: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  const fmt = (x: number) => x.toFixed(1).padStart(9);
  console.log(`\n=== ${label} ===`);
  console.log(
    `  samples ${sorted.length}   errors ${errors}   wall ${(wallMs / 1000).toFixed(1)}s   ` +
      `throughput ${(sorted.length / (wallMs / 1000)).toFixed(1)} req/s`,
  );
  console.log(`  min  ${fmt(sorted[0]!)} ms`);
  console.log(`  p50  ${fmt(percentile(sorted, 50))} ms`);
  console.log(`  p95  ${fmt(percentile(sorted, 95))} ms`);
  console.log(`  p99  ${fmt(percentile(sorted, 99))} ms`);
  console.log(`  max  ${fmt(sorted[sorted.length - 1]!)} ms`);
}

// Per-arm p50/p95 breakdown for retrieval-only mode. The two DB queries run
// sequentially in hybridSearch() (separate awaits), so vector + keyword + RRF
// roughly sum to the total; the small remainder is call/instrumentation overhead.
function reportArms(arm: { vector: number[]; keyword: number[]; fusion: number[] }) {
  const line = (name: string, xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const p = (q: number) => percentile(s, q).toFixed(2).padStart(8);
    return `  ${name.padEnd(18)} p50 ${p(50)} ms   p95 ${p(95)} ms   (n=${s.length})`;
  };
  console.log(`\n--- per-arm breakdown (sequential awaits: pgvector -> ILIKE -> RRF) ---`);
  console.log(line("(a) pgvector", arm.vector));
  console.log(line("(b) ILIKE lexical", arm.keyword));
  console.log(line("(c) RRF fusion", arm.fusion));
}

async function main() {
  // Safety gate BEFORE touching the DB: never point the bench at a remote DB.
  const { url: dbUrl, host: dbHostName } = requireSafeDatabaseUrl();
  const opts = parseArgs();
  const meta = await getMeta();
  const anyGlobal = globalThis as any;
  const runtime = anyGlobal.Bun ? `Bun ${anyGlobal.Bun.version}` : `Node ${process.version}`;

  console.log("Recall hybrid-search latency benchmark");
  console.log(`  runtime:       ${runtime}  (process.version ${process.version})`);
  console.log(`  env file:      recall-backend/.env (Bun auto-load)`);
  console.log(`  DB host:       ${dbHostName}  (local: ${isLocalDatabase(dbUrl)})`);
  console.log(`  contents rows: ${meta.total}  (with embedding: ${meta.withEmbedding})`);
  console.log(`  vector index:  ${meta.indexType}`);
  if (meta.indexdef) console.log(`  index def:     ${meta.indexdef}`);
  const modeLabel = opts.retrievalOnly
    ? "retrieval-only (precomputed embedding: pgvector + ILIKE + RRF)"
    : "end-to-end /search (includes live OpenAI embed)";
  console.log(`  mode:          ${modeLabel}`);
  console.log(
    `  protocol:      ${opts.warmup} warmup + ${opts.measured} measured, ` +
      `${QUERIES.length} rotating queries, concurrency ${opts.concurrency}`,
  );

  // One-shot EXPLAIN: does the bench's exact vector query actually use HNSW?
  if (meta.indexType.startsWith("hnsw")) {
    try {
      const { usesHnsw, scanLine } = await verifyHnswUsage(await getBenchUserId());
      console.log(`  hnsw check:    ${usesHnsw ? "USED — Index Scan (hnsw) ✓" : "NOT used — Seq Scan ✗"}`);
      console.log(`                 plan: ${scanLine}`);
      if (!usesHnsw) {
        console.log(
          `                 (only ${meta.withEmbedding} rows have embeddings; the planner ` +
            `favors a Seq Scan on small tables — seed more rows to make the index engage)`,
        );
      }
    } catch (e) {
      console.log(`  hnsw check:    skipped (${(e as Error).message})`);
    }
  } else {
    console.log(`  hnsw check:    skipped (no hnsw index present)`);
  }

  try {
    if (opts.retrievalOnly) {
      const userId = await getBenchUserId();
      const { embeddings, synthetic } = await loadQueryEmbeddings();
      console.log(
        `  query embeddings: ${synthetic ? "synthetic (random unit vectors)" : "openai (cached)"}`,
      );
      // Per-arm samples (pgvector / ILIKE / RRF), collected via the optional
      // timings out-param on hybridSearch(). Cleared after warmup below.
      const arm = { vector: [] as number[], keyword: [] as number[], fusion: [] as number[] };
      const doOne = async (q: string): Promise<Sample> => {
        const t: HybridSearchTimings = { vectorMs: 0, keywordMs: 0, fusionMs: 0 };
        const t0 = performance.now();
        try {
          await hybridSearch(userId, q, embeddings[q] ?? null, t);
          const ms = performance.now() - t0;
          arm.vector.push(t.vectorMs);
          arm.keyword.push(t.keywordMs);
          arm.fusion.push(t.fusionMs);
          return { ms, ok: true };
        } catch {
          return { ms: performance.now() - t0, ok: false };
        }
      };
      await runPool(opts.warmup, 1, doOne); // warmup (discarded)
      arm.vector.length = arm.keyword.length = arm.fusion.length = 0; // drop warmup arm samples
      const t0 = performance.now();
      const { samples, errors } = await runPool(opts.measured, opts.concurrency, doOne);
      report(modeLabel, samples, errors, performance.now() - t0);
      reportArms(arm);
    } else {
      const token = await getToken(opts.apiUrl);
      const doOne = async (q: string): Promise<Sample> => {
        const t0 = performance.now();
        try {
          const res = await fetch(`${opts.apiUrl}/api/v1/search?q=${encodeURIComponent(q)}`, {
            headers: { authorization: token },
          });
          await res.text(); // drain body so timing includes full response
          return { ms: performance.now() - t0, ok: res.ok };
        } catch {
          return { ms: performance.now() - t0, ok: false };
        }
      };
      await runPool(opts.warmup, 1, doOne); // warmup (discarded)
      const t0 = performance.now();
      const { samples, errors } = await runPool(opts.measured, opts.concurrency, doOne);
      report(modeLabel, samples, errors, performance.now() - t0);
    }
  } finally {
    await (db.$client as any)?.end?.(); // close pg pool so the process exits
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
