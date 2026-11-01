// Chooses the fusion weights and k on the SciFact TRAIN split only. The test split
// is never loaded here.
//
//   bun --no-env-file run eval/tune-fusion.ts
//
// Each train query runs once through hybridSearch for each arm, and every grid
// setting is then fused by the production reciprocalRankFusion(). The vector weight
// stays at 1, since only the ratio matters. A zero FTS weight is not in the grid:
// that would be vector only, not hybrid.
//
// Selection rule, fixed before looking at any result: highest mean nDCG@10; ties go
// to the higher FTS weight, then the higher k.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { createDb, type Db } from "../config/db";
import { users } from "../db/schema";
import { hybridSearch, reciprocalRankFusion } from "../services/searchService";
import {
  DiskCache, EVAL_USER_EMAIL, RESULTS_DIR, docIdFromLink, embeddingKey, evalDatabaseUrl, loadTrainQueries,
} from "./lib";
import { mean, mrrAt, ndcgAt, recallAt } from "./metrics";

const K = 10;
const FTS_WEIGHTS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2];
const RRF_KS = [1, 2, 3, 5, 10, 20, 30, 60, 100, 200];

process.env.DRIZZLE_LOGGER = "false";
const cache = new DiskCache<number[]>("embeddings");
const queries = loadTrainQueries();
const db = createDb(evalDatabaseUrl()) as unknown as Db & { $client: pg.Pool };
const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, EVAL_USER_EMAIL));
if (!user) throw new Error("no eval user: run eval/ingest.ts first");

const arms: Array<{ q: (typeof queries)[number]; vector: Array<Record<string, any>>; fts: Array<Record<string, any>> }> = [];
for (const q of queries) {
  const embedding = cache.get(embeddingKey(q.text));
  if (!embedding) throw new Error(`no cached embedding for train query ${q.id}: run eval/embed-train.ts`);
  arms.push({
    q,
    vector: await hybridSearch(db, user.id, q.text, embedding, undefined, "vector"),
    fts: await hybridSearch(db, user.id, q.text, null, undefined, "fts"),
  });
}
await db.$client.end();

const score = (ranked: Array<Record<string, any>>, q: (typeof queries)[number]) => {
  const ids = ranked.map((r) => docIdFromLink(r.link as string));
  return { ndcg: ndcgAt(ids, q.relevant, K), recall: recallAt(ids, q.relevant, K), mrr: mrrAt(ids, q.relevant, K) };
};
const summarize = (scores: Array<ReturnType<typeof score>>) => ({
  ndcg: mean(scores.map((s) => s.ndcg)),
  recall: mean(scores.map((s) => s.recall)),
  mrr: mean(scores.map((s) => s.mrr)),
});

const vectorScores = arms.map((a) => score(a.vector, a.q));
const evaluate = (ftsWeight: number, k: number) => {
  const scores = arms.map((a) =>
    score(reciprocalRankFusion(a.vector, a.fts, { vectorWeight: 1, ftsWeight, k }), a.q),
  );
  const compare = { wins: 0, losses: 0, ties: 0 };
  scores.forEach((s, i) => {
    const v = vectorScores[i]!.ndcg;
    if (s.ndcg > v + 1e-12) compare.wins++;
    else if (s.ndcg < v - 1e-12) compare.losses++;
    else compare.ties++;
  });
  return { ftsWeight, k, ...summarize(scores), vsVector: compare };
};

const grid = FTS_WEIGHTS.flatMap((w) => RRF_KS.map((k) => evaluate(w, k)));
const ranked = [...grid].sort(
  (a, b) => b.ndcg - a.ndcg || b.ftsWeight - a.ftsWeight || b.k - a.k,
);

const output = {
  split: "train",
  queries: queries.length,
  gridSize: grid.length,
  ftsWeights: FTS_WEIGHTS,
  rrfKs: RRF_KS,
  vectorOnly: summarize(vectorScores),
  ftsOnly: summarize(arms.map((a) => score(a.fts, a.q))),
  equalWeightK60: evaluate(1, 60),
  winner: ranked[0],
  top: ranked.slice(0, 8),
  grid,
};
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, "fusion-tuning.json"), JSON.stringify(output, null, 2) + "\n");

const { grid: _grid, top, ...brief } = output;
console.log(JSON.stringify(brief, null, 1));
console.table(top.map((t) => ({ w: t.ftsWeight, k: t.k, ndcg: t.ndcg.toFixed(4), recall: t.recall.toFixed(4), mrr: t.mrr.toFixed(4), ...t.vsVector })));
