// Embeds the SciFact train queries into the disk cache, for eval/tune-fusion.ts.
//   bun run eval/embed-train.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGenerateEmbedding } from "../services/embeddings";
import { DiskCache, RESULTS_DIR, embeddingKey, loadTrainQueries, requireEnv } from "./lib";

delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

const generateEmbedding = createGenerateEmbedding(requireEnv("OPENAI_API_KEY"));
const cache = new DiskCache<number[]>("embeddings");
const queries = loadTrainQueries();

let tokens = 0;
let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const response = await realFetch(input, init);
  if (String(input?.url ?? input).startsWith("https://api.openai.com/v1/embeddings") && response.ok) {
    const body: any = await response.clone().json();
    tokens += body.usage?.total_tokens ?? 0;
    calls++;
  }
  return response;
}) as typeof fetch;

for (let i = 0; i < queries.length; i += 8) {
  await Promise.all(
    queries.slice(i, i + 8).map(async (q) => {
      const key = embeddingKey(q.text);
      if (cache.get(key)) return;
      const vector = await generateEmbedding(q.text);
      if (!vector) throw new Error(`STOP: embedding failed for query ${q.id}`);
      cache.set(key, vector);
    }),
  );
}

const stats = { queries: queries.length, embeddingCalls: calls, embeddingTokens: tokens };
console.log(stats);
if (calls > 0) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, "train-embedding-stats.json"), JSON.stringify(stats, null, 2) + "\n");
}
