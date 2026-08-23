// Deterministic data + query generation for the rigor benchmark.
//
// Everything here is a pure function of fixed string seeds — re-running at any
// scale reproduces byte-identical rows and queries. Scales are prefix-stable:
// row i is identical whether the run seeds 1k, 10k, or 50k rows.

import { DIM, hashStringToSeed, mulberry32 } from "../shared";

export const N_QUERIES = 200;

// --- deterministic PRNG helpers ---------------------------------------------

function rngFor(seed: string): () => number {
  return mulberry32(hashStringToSeed(seed));
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

// Same technical vocabulary flavor as bench/shared.ts, fixed list.
const VOCAB = (
  "postgres query optimize react server components vector database similarity search " +
  "kubernetes deployment typescript generics machine learning evaluation metrics rust " +
  "ownership memory safety distributed consensus graphql rest api docker build caching " +
  "authentication session css grid layout python async concurrency indexing btree " +
  "microservices communication llm prompt engineering performance vitals git rebase " +
  "lambda cold start latency event driven kafka system data model service network " +
  "cluster throughput cache index engine schema pipeline runtime storage protocol " +
  "request response handler module function pattern architecture scaling reliability " +
  "observability tracing logging benchmark framework library dependency container " +
  "orchestration release rollback migration transaction consistency availability " +
  "partition replication sharding embedding retrieval ranking relevance semantic " +
  "lexical fusion tuning"
).split(/\s+/);

// --- text queries / seeded phrases ------------------------------------------

// 200 fixed 3-word phrases. They double as (a) the text-query set and (b) the
// phrases seeded into row text, so the ILIKE arm has real hits at every scale.
export function textQueries(): string[] {
  const out: string[] = [];
  for (let j = 0; j < N_QUERIES; j++) {
    const rng = rngFor(`phrase:${j}`);
    // 3 distinct words so phrases are unlikely to be substrings of each other.
    const w = new Set<string>();
    while (w.size < 3) w.add(pick(rng, VOCAB));
    out.push([...w].join(" "));
  }
  return out;
}

// --- deterministic embeddings ------------------------------------------------

// Box-Muller gaussian -> unit vector, from a seeded rng (mirrors shared.ts's
// unitVectorFromRng, which is not exported).
function unitVector(rng: () => number, dim: number): number[] {
  const v = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const u1 = rng() || 1e-12;
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

export function rowEmbedding(i: number): number[] {
  return unitVector(rngFor(`emb:${i}`), DIM);
}

export function queryEmbedding(j: number): number[] {
  return unitVector(rngFor(`qvec:${j}`), DIM);
}

// --- deterministic row text ---------------------------------------------------

export interface RigorRow {
  link: string;
  title: string;
  ogTitle: string;
  summary: string;
  ogDescription: string;
  extractedText: string;
}

function words(rng: () => number, min: number, max: number): string {
  const n = min + Math.floor(rng() * (max - min + 1));
  return Array.from({ length: n }, () => pick(rng, VOCAB)).join(" ");
}

function sentence(rng: () => number): string {
  const s = words(rng, 8, 18);
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function paragraph(rng: () => number, sentences: number): string {
  return Array.from({ length: sentences }, () => sentence(rng)).join(" ");
}

export function makeRow(i: number, phrases: string[]): RigorRow {
  const rng = rngFor(`row:${i}`);
  // ~60% of rows carry one of the 200 fixed phrases verbatim (round-robin), so
  // each phrase has hits at every scale (≈3 at 1k, ≈30 at 10k, ≈150 at 50k).
  const phrase = rng() < 0.6 ? phrases[i % phrases.length]! : "";
  const titleCore = (phrase ? phrase + " " : "") + words(rng, 3, 6);
  const title = (titleCore.charAt(0).toUpperCase() + titleCore.slice(1)).slice(0, 120);
  return {
    link: `https://synthetic.bench/rigor/${i}`,
    title,
    ogTitle: title,
    summary: (phrase ? phrase + " — " : "") + paragraph(rng, 2),
    ogDescription: paragraph(rng, 2),
    extractedText: Array.from(
      { length: 6 + Math.floor(rng() * 6) },
      () => paragraph(rng, 4),
    ).join("\n\n"),
  };
}

// Bench DB name/url per scale, derived from the base DATABASE_URL so no
// credentials appear in commands or the repo.
export function benchDbName(scale: number): string {
  return `recall_bench_${scale}`;
}

export function benchDbUrl(baseUrl: string, scale: number): string {
  const u = new URL(baseUrl);
  u.pathname = "/" + benchDbName(scale);
  return u.toString();
}
