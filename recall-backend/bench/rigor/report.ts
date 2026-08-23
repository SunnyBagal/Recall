// Assemble bench/results/<sha>/report.md from the raw run JSON.
//
//   bun run bench/rigor/report.ts
//
// Reads every bench/results/<sha>/raw/scale*.json for the CURRENT commit and
// emits the report + prints the data-supported summary sentences to stdout.

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { percentile } from "../shared";

function sh(cmd: string): string {
  try { return execSync(cmd).toString().trim(); } catch { return "(unavailable)"; }
}

const shaShort = sh("git rev-parse --short HEAD");
const shaFull = sh("git rev-parse HEAD");
// Uncommitted CODE only — the results dir this tooling writes doesn't count.
const dirty = sh("git status --porcelain").split("\n")
  .some((l) => l.trim() && !l.includes("bench/results"));
const dir = `bench/results/${shaShort}`;

const files = readdirSync(`${dir}/raw`).filter((f) => /^scale\d+\.json$/.test(f));
if (!files.length) throw new Error(`no raw results in ${dir}/raw`);
const runs = files
  .map((f) => JSON.parse(readFileSync(`${dir}/raw/${f}`, "utf8")))
  .sort((a, b) => a.meta.scale - b.meta.scale);

const stats = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95) };
};
const f1 = (x: number) => x.toFixed(1);

const ARM_DESC: Record<string, string> = {
  A: "sequential scan (SET LOCAL enable_indexscan=off, enable_bitmapscan=off) — exact",
  B: "HNSW available, default planner, no overrides",
  C: "scoped override as implemented: transaction + SET LOCAL enable_seqscan=off",
  D: "lexical arm alone (ILIKE over title/summary/og_title/og_description)",
  E: "full hybrid end-to-end at app layer: real hybridSearch() (C-vector + D-ILIKE + RRF)",
};

// ---- table ------------------------------------------------------------------
let table =
  "| Arm | Rows | p50 (ms) | p95 (ms) | recall@10 vs A | n |\n" +
  "|---|---:|---:|---:|---:|---:|\n";
for (const run of runs) {
  for (const arm of ["A", "B", "C", "D", "E"]) {
    if (!run[arm]) continue;
    const s = stats(run[arm].samples);
    const rec =
      arm === "A" ? "1.000 (truth)" :
      run[arm].recallAt10 != null ? run[arm].recallAt10.toFixed(3) : "—";
    table += `| ${arm} | ${run.meta.scale.toLocaleString("en-US")} | ${f1(s.p50)} | ${f1(s.p95)} | ${rec} | ${s.n} |\n`;
  }
}

// ---- claim check (10k, A vs C) ---------------------------------------------
const r10k = runs.find((r) => r.meta.scale === 10000);
let claim = "10k run missing — claim not checkable.";
let sentences: string[] = [];
if (r10k?.A && r10k?.C) {
  const a = stats(r10k.A.samples), c = stats(r10k.C.samples);
  const ratio = a.p50 / c.p50;
  claim =
    `Existing claim "46ms → 9ms (5×)": measured p50 at 10k rows is ` +
    `${f1(a.p50)}ms (seq scan) → ${f1(c.p50)}ms (HNSW, scoped override) = ${ratio.toFixed(1)}×. ` +
    (a.p50 >= 40 && a.p50 <= 52 && c.p50 >= 7 && c.p50 <= 11 && ratio >= 4 && ratio <= 6
      ? "The claim REPRODUCES within tolerance."
      : `The claim as stated does NOT reproduce; the honest numbers are ${f1(a.p50)}ms → ${f1(c.p50)}ms (${ratio.toFixed(1)}×).`);
  sentences.push(
    `On 10,000 synthetic 1536-dim rows, forcing the planner onto the HNSW index cut vector top-10 p50 latency from ${f1(a.p50)}ms to ${f1(c.p50)}ms (${ratio.toFixed(1)}×; p95 ${f1(a.p95)}ms → ${f1(c.p95)}ms), at ${(r10k.C.recallAt10 * 100).toFixed(1)}% recall@10 against the exact scan.`,
  );
  if (r10k.B) {
    const b = stats(r10k.B.samples);
    const bLikeSeq = Math.abs(b.p50 - a.p50) / a.p50 < 0.25;
    sentences.push(
      bLikeSeq
        ? `The default planner never chose the HNSW index at this scale (arm B p50 ${f1(b.p50)}ms ≈ seq-scan arm A ${f1(a.p50)}ms) — the scoped SET LOCAL enable_seqscan=off override in the app is what actually engages the index.`
        : `Arm B (default planner) measured p50 ${f1(b.p50)}ms — see EXPLAIN for which plan it chose.`,
    );
  }
  if (r10k.E) {
    const e = stats(r10k.E.samples);
    sentences.push(
      `The full hybrid path (vector + lexical + reciprocal-rank fusion), measured end-to-end at the application layer, runs at p50 ${f1(e.p50)}ms / p95 ${f1(e.p95)}ms on 10,000 rows.`,
    );
  }
}
const r1k = runs.find((r) => r.meta.scale === 1000);
const r50k = runs.find((r) => r.meta.scale === 50000);
if (r1k?.A && r1k?.C && r50k?.A && r50k?.C) {
  const a1 = stats(r1k.A.samples), c1 = stats(r1k.C.samples);
  const a50 = stats(r50k.A.samples), c50 = stats(r50k.C.samples);
  const rec = (r: any) => (r.C.recallAt10 != null ? `${(r.C.recallAt10 * 100).toFixed(1)}%` : "?");
  sentences.push(
    `The latency advantage grows with corpus size — seq-scan vs HNSW p50 is ${f1(a1.p50)}ms vs ${f1(c1.p50)}ms at 1k rows (${(a1.p50 / c1.p50).toFixed(1)}×) and ${f1(a50.p50)}ms vs ${f1(c50.p50)}ms at 50k rows (${(a50.p50 / c50.p50).toFixed(1)}×) — but on this synthetic vector distribution recall@10 falls with it (${rec(r1k)} at 1k, ${r10k?.C?.recallAt10 != null ? (r10k.C.recallAt10 * 100).toFixed(1) + "% at 10k, " : ""}${rec(r50k)} at 50k), so the speedup cannot be quoted at scale without a recall figure from real embeddings.`,
  );
  sentences.push(
    `Caution: with the default hnsw.ef_search=40, HNSW recall@10 against the exact scan collapsed as N grew on fixed-seed random unit vectors (a known worst case for graph navigation — uniform random high-dim vectors have no cluster structure). Real embedding recall was NOT measured here; validate it (or raise ef_search) before citing the HNSW numbers as production quality.`,
  );
}

// ---- arm E phase breakdown --------------------------------------------------
let phaseSection = "";
if (r10k?.E?.phases) {
  const p = r10k.E.phases;
  const line = (name: string, xs: number[]) => {
    const s = stats(xs);
    return `| ${name} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} |\n`;
  };
  phaseSection =
    "\n## Arm E phase breakdown (10k rows, sequential awaits)\n\n" +
    "| Phase | p50 (ms) | p95 (ms) |\n|---|---:|---:|\n" +
    line("pgvector query (C-style)", p.vector) +
    line("ILIKE lexical query", p.keyword) +
    line("RRF fusion (in JS)", p.fusion);
}

// ---- environment ------------------------------------------------------------
const meta = runs[0].meta;
const hw = {
  cpu: sh("sysctl -n machdep.cpu.brand_string"),
  cores: sh("sysctl -n hw.ncpu"),
  memGB: (parseInt(sh("sysctl -n hw.memsize"), 10) / 2 ** 30).toFixed(0),
  macos: sh("sw_vers -productVersion"),
  bun: sh("bun --version"),
  container: sh("docker ps --filter publish=5432 --format '{{.Image}} ({{.Names}})'"),
};

const explainFiles = readdirSync(`${dir}/explain`).sort();
const explainLinks = explainFiles.map((f) => `- [\`${f}\`](explain/${f})`).join("\n");

const report = `# Recall retrieval benchmark — rigor run

- **Date:** ${meta.date}
- **Commit:** \`${shaFull}\`${dirty ? " — **dirty working tree** (bench code + search service are uncommitted; see `git status` at run time)" : ""}
- **Hardware:** ${hw.cpu}, ${hw.cores} cores, ${hw.memGB} GB RAM, macOS ${hw.macos}
- **Database:** ${meta.pg}
  - Runs in Docker: \`${hw.container}\` (localhost:5432, no explicit container CPU/memory limits)
- **pgvector:** ${meta.pgvector} · HNSW \`m=16, ef_construction=64\`, \`vector_cosine_ops\`, \`hnsw.ef_search=${meta.ef_search}\` (default, unchanged)
- **Client:** Bun ${hw.bun}, node-postgres, one dedicated connection per run, queries strictly sequential

## Honesty caveats — read before quoting

1. **The lexical arm is ILIKE, not FTS.** The codebase (\`services/searchService.ts\`) implements
   \`ILIKE '%query%'\` over title/summary/og_title/og_description — there is no tsvector column or
   GIN index anywhere in the schema. Arm D measures what is actually implemented. Any claim that
   says "Postgres FTS" is not supported by this codebase.
2. **Embeddings are synthetic random unit vectors** (deterministic, fixed-seed). Latency and
   index-vs-scan comparisons are valid (HNSW does the same work over any 1536-dim unit vector);
   random vectors are close to a worst case for HNSW recall, so real-embedding recall@10 is
   plausibly higher than reported here, not lower. Semantic result *quality* is out of scope.
3. **The app's 0.3 similarity cutoff filters out all synthetic matches** (random 1536-dim unit
   vectors have similarity ≈ 0 ± 0.06), so in arm E the fused output is keyword-driven. The vector
   query still executes in full — timings are unaffected — but arm E's fused-result composition on
   real data would differ.
4. Arms A and C include their \`BEGIN\`/\`SET LOCAL\`/\`COMMIT\` round-trips in the measured time,
   because the application pays exactly that cost (\`db.transaction\` + \`set local\`). Arm B is a
   bare query, as the default-planner path would be.
5. All rows belong to one bench user, so the \`WHERE user_id = $x\` filter (which the app always
   applies) matches every row. Multi-tenant selectivity effects are not measured here.
6. Rows and queries are fully deterministic (fixed seeds), but **pgvector's HNSW build itself is
   stochastic** (node levels are assigned randomly), so the graph — and recall@10 — varies
   slightly between rebuilds (observed ≈±2pp at 10k across two builds). Latency is unaffected.

## Protocol

- Dedicated databases \`recall_bench_{1000,10000,50000}\`, dropped and rebuilt per seed. Dev data untouched.
- 10,000 / 1,000 / 50,000 deterministic rows (fixed-seed mulberry32 PRNG; row *i* is identical at
  every scale), each with a 1536-dim random **unit** embedding and generated article-length text;
  200 of the rows' title/summary phrases double as the text-query set so ILIKE has real hits.
- 200 fixed-seed query vectors + 200 fixed text queries; the same query set for every arm.
- **Cache policy: warm.** Explicit warm pass (the full 200-query set once, discarded) per arm,
  then 3 measured rounds × 200 queries. No OS/PG cache drops between rounds. Percentiles are
  nearest-rank over all ${3 * 200} measured samples per arm×scale.
- Recall@10: arm A (forced seq scan → exact top-10) is ground truth; overlap of B/C top-10 ids.

## Arms

${(["A", "B", "C", "D", "E"] as const).map((a) => `- **${a}** — ${ARM_DESC[a]}`).join("\n")}

The vector SQL is byte-equivalent to the app's query: same projection, \`users\` join,
\`user_id\` filter, \`ORDER BY embedding <=> $q ASC LIMIT 10\`, no distance predicate.

## Results

${table}
${phaseSection}
## Claim check

${claim}

## Summary sentences supported by this data

${sentences.map((s) => `> ${s}`).join("\n\n")}

## EXPLAIN (ANALYZE, BUFFERS)

One representative capture (query #0) per arm × scale:

${explainLinks}

## Re-run

\`\`\`bash
cd recall-backend   # DATABASE_URL comes from .env; scripts refuse non-local hosts
bun run bench/rigor/seed.ts --scale=1000  && bun run bench/rigor/run.ts --scale=1000  --arms=A,C
bun run bench/rigor/seed.ts --scale=10000 && bun run bench/rigor/run.ts --scale=10000
bun run bench/rigor/seed.ts --scale=50000 && bun run bench/rigor/run.ts --scale=50000 --arms=A,C
bun run bench/rigor/report.ts
\`\`\`

Raw per-query samples: [\`raw/\`](raw/) (one JSON per scale, includes full sample arrays and arm-E phase timings).
`;

writeFileSync(`${dir}/report.md`, report);
console.log(`wrote ${dir}/report.md\n`);
console.log("== Claim check ==\n" + claim + "\n");
console.log("== Resume-safe sentences ==");
for (const s of sentences) console.log("• " + s);
