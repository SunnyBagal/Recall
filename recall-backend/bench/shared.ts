// Shared constants + helpers for the hybrid-search benchmark.
// No external imports so this file loads under any runtime; the seed/bench
// scripts pull in pg/argon2/drizzle from recall-backend/node_modules.

export const DIM = 1536; // matches vector("embedding", { dimensions: 1536 }) in db/schema.ts
export const TARGET_DEFAULT = 10_000;
export const SYNTHETIC_TAG = "__bench_synthetic__"; // one-tag wipe handle

// Dedicated user that owns every synthetic row. Search is per-user
// (WHERE user_id = ...), so the benchmark must query as this user.
export const BENCH_USER = {
  username: "bench_user",
  email: "bench-user@bench.local",
  password: "benchPassw0rd!seed",
};

export const DEFAULT_API_URL = process.env.BENCH_API_URL ?? "http://localhost:3000";

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL not set. Run from recall-backend/ (Bun auto-loads its .env), e.g.\n" +
        "  cd recall-backend && bun run bench/seed-vectors.ts",
    );
    process.exit(1);
  }
  return url;
}

// Host of DATABASE_URL, IPv6 brackets stripped (e.g. "[::1]" -> "::1").
export function dbHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "(unparseable)";
  }
}

export function isLocalDatabase(url: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(dbHost(url));
}

/**
 * Presence + SAFETY gate for the seed/bench scripts. These SEED and WIPE data,
 * so they must never silently run against a remote (e.g. production Railway) DB.
 * Refuses to proceed unless the host is local, or an explicit --allow-remote
 * flag is passed. Returns the validated url + host for the startup banner.
 */
export function requireSafeDatabaseUrl(argv: string[] = process.argv.slice(2)): {
  url: string;
  host: string;
} {
  const url = requireDatabaseUrl();
  const host = dbHost(url);
  const allowRemote = argv.includes("--allow-remote");

  if (!isLocalDatabase(url) && !allowRemote) {
    console.error(
      "\n############################################################\n" +
        "#  ABORT: refusing to run against a NON-LOCAL database.\n" +
        `#    DATABASE_URL host: ${host}\n` +
        "#    These scripts SEED and WIPE data — they must never run\n" +
        "#    against the production Railway DB.\n" +
        "#    If you REALLY intend this, re-run with  --allow-remote\n" +
        "############################################################\n",
    );
    process.exit(1);
  }
  return { url, host };
}

// 20 realistic knowledge-base queries. Rotated (never a single repeated query)
// so we don't just benchmark Postgres's cache for one plan.
export const QUERIES = [
  "how to optimize postgres queries",
  "react server components explained",
  "vector database similarity search",
  "kubernetes deployment strategies",
  "typescript generics tutorial",
  "machine learning model evaluation metrics",
  "rust ownership and memory safety",
  "distributed systems consensus algorithms",
  "graphql versus rest api design",
  "docker multi stage build caching",
  "authentication and session best practices",
  "css grid layout complete guide",
  "python async await concurrency",
  "database indexing strategies b-tree",
  "microservices communication patterns",
  "llm prompt engineering techniques",
  "web performance core web vitals",
  "git rebase and interactive workflow",
  "aws lambda cold start latency",
  "event driven architecture with kafka",
];

// Vocabulary for synthetic text: query terms + tech filler, so the ILIKE arm
// has both real hits and real misses to scan.
const VOCAB = Array.from(
  new Set(
    QUERIES.join(" ")
      .split(/\s+/)
      .concat(
        (
          "system data model service network cluster latency throughput cache index query engine " +
          "schema pipeline runtime memory storage protocol request response handler module function " +
          "pattern architecture scaling reliability observability metrics tracing logging benchmark " +
          "performance optimization framework library dependency container orchestration deployment " +
          "release rollback migration transaction consistency availability partition replication " +
          "sharding embedding retrieval ranking relevance semantic lexical fusion tuning throughput"
        ).split(" "),
      ),
  ),
);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function words(min: number, max: number): string {
  const n = min + Math.floor(Math.random() * (max - min + 1));
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(VOCAB));
  return out.join(" ");
}

function sentence(): string {
  const s = words(8, 18);
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function paragraph(sentences: number): string {
  return Array.from({ length: sentences }, sentence).join(" ");
}

export interface SyntheticRow {
  link: string;
  title: string;
  ogTitle: string;
  summary: string;
  ogDescription: string;
  extractedText: string;
}

export function makeContentRow(i: number): SyntheticRow {
  // Seed a real query phrase into ~60% of rows so the ILIKE arm returns hits.
  const seededQuery = Math.random() < 0.6 ? pick(QUERIES) : "";
  const titleCore = (seededQuery ? seededQuery + " " : "") + words(3, 6);
  const title = (titleCore.charAt(0).toUpperCase() + titleCore.slice(1)).slice(0, 120);
  const summary = (seededQuery ? seededQuery + " — " : "") + paragraph(2);
  const ogDescription = paragraph(2);
  // ~6-11 paragraphs of ~4 sentences => a few thousand chars, real article length.
  const extractedText = Array.from(
    { length: 6 + Math.floor(Math.random() * 6) },
    () => paragraph(4),
  ).join("\n\n");
  return {
    link: `https://synthetic.bench/item/${i}`,
    title,
    ogTitle: title,
    summary,
    ogDescription,
    extractedText,
  };
}

// FNV-1a 32-bit string hash -> unsigned 32-bit seed.
export function hashStringToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: small, fast, deterministic PRNG in [0, 1).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Unit vector (Box-Muller gaussian -> normalize) drawn from an arbitrary RNG.
function unitVectorFromRng(rng: () => number, dim: number): number[] {
  const v = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const u1 = rng() || 1e-12;
    const u2 = rng();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

// Non-deterministic random unit vector (used for seeding row embeddings).
export function randomUnitVector(dim = DIM): number[] {
  return unitVectorFromRng(Math.random, dim);
}

// Deterministic unit vector seeded from a string — identical across runs.
export function seededUnitVector(seedStr: string, dim = DIM): number[] {
  return unitVectorFromRng(mulberry32(hashStringToSeed(seedStr)), dim);
}

export function vectorLiteral(v: number[]): string {
  return "[" + v.join(",") + "]";
}

// Nearest-rank percentile from raw sorted samples (no averaging buckets).
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[idx]!;
}
