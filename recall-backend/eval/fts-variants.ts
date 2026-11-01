// Chooses the FTS fix on SciFact's TRAIN split, so the held-out test split behind
// the before/after tables plays no part in the choice.
//
//   bun --no-env-file run eval/fts-variants.ts
//
// SQL here mirrors the FTS arm in services/searchService.ts with the tsquery
// swapped. No API calls: FTS needs no embeddings.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { DATA_DIR, EVAL_USER_EMAIL, RESULTS_DIR, docIdFromLink, evalDatabaseUrl } from "./lib";
import { mean, mrrAt, ndcgAt, percentile, recallAt, type Relevance } from "./metrics";

const K = 10;

const qrels = new Map<string, Relevance>();
for (const line of readFileSync(join(DATA_DIR, "qrels", "train.tsv"), "utf8").trim().split("\n").slice(1)) {
  const [qid, docId, score] = line.split("\t") as [string, string, string];
  if (!qrels.has(qid)) qrels.set(qid, new Map());
  qrels.get(qid)!.set(docId, Number(score));
}
const queries = readFileSync(join(DATA_DIR, "queries.jsonl"), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l) as { _id: string; text: string })
  .filter((q) => qrels.has(q._id));

const client = new pg.Client({ connectionString: evalDatabaseUrl() });
await client.connect();
const userId = (await client.query("select id from users where email = $1", [EVAL_USER_EMAIL])).rows[0].id;

const AND = `websearch_to_tsquery('english', $2)`;
const OR = `replace(websearch_to_tsquery('english', $2)::text, ' & ', ' | ')::tsquery`;

const search = async (tsq: string, text: string): Promise<string[]> =>
  (await client.query(
    `select link from contents
     where user_id = $1 and search_vector @@ ${tsq}
     order by ts_rank(search_vector, ${tsq}) desc limit ${K}`,
    [userId, text],
  )).rows.map((r) => docIdFromLink(r.link));

const variants: Record<string, (text: string) => Promise<string[]>> = {
  "and (current)": (t) => search(AND, t),
  or: (t) => search(OR, t),
  "and, fall back to or when empty": async (t) => {
    const hits = await search(AND, t);
    return hits.length ? hits : search(OR, t);
  },
  "and, then fill the top 10 from or": async (t) => {
    const hits = await search(AND, t);
    if (hits.length >= K) return hits;
    const seen = new Set(hits);
    return [...hits, ...(await search(OR, t)).filter((id) => !seen.has(id))].slice(0, K);
  },
};

const results: Record<string, any> = {};
for (const [name, run] of Object.entries(variants)) {
  for (const q of queries) await run(q.text); // warm-up, discarded
  const ms: number[] = [];
  const scores = { ndcg: [] as number[], recall: [] as number[], mrr: [] as number[] };
  let empty = 0;
  for (const q of queries) {
    const t0 = performance.now();
    const ranked = await run(q.text);
    ms.push(performance.now() - t0);
    const rel = qrels.get(q._id)!;
    if (ranked.length === 0) empty++;
    scores.ndcg.push(ndcgAt(ranked, rel, K));
    scores.recall.push(recallAt(ranked, rel, K));
    scores.mrr.push(mrrAt(ranked, rel, K));
  }
  results[name] = {
    ndcg: mean(scores.ndcg),
    recall: mean(scores.recall),
    mrr: mean(scores.mrr),
    queriesWithNoResults: empty,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
  };
  console.log(name, JSON.stringify(results[name]));
}
await client.end();

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(
  join(RESULTS_DIR, "fts-variants.json"),
  JSON.stringify({ split: "train", queries: queries.length, k: K, variants: results }, null, 2) + "\n",
);
