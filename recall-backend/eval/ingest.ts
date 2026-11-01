// Loads SciFact into the local eval database through Recall's real ingestion
// code: rows are inserted as pending, jobs go through BullMQ on local Redis, and
// the unmodified processContent() from worker.ts runs with the real summarizer
// and embedding clients. Both clients are wrapped in a disk cache, so a rerun
// costs nothing.
//
//   bun run eval/ingest.ts              # resets recall_eval, then ingests all docs
//   bun run eval/ingest.ts --limit=100  # dry run: first N docs, for token counts
//
// Differences from production, all deliberate:
//  - fetchMetadata is skipped (the corpus has no URLs). Rows start the way
//    POST /content leaves them: title = og_title = doc title, extracted_text =
//    doc text, status pending.
//  - worker concurrency is 12 (production: 3), and attempts is 6 (production: 3).
//  - the embedding wrapper throws on a null result, which is what processContent
//    does anyway, and also keeps null out of the disk cache.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Queue, Worker } from "bullmq";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import IORedis from "ioredis";
import pg from "pg";
import { createDb, type Db } from "../config/db";
import * as schema from "../db/schema";
import { contents, users } from "../db/schema";
import { generateSummaryAndTags, type AISummaryResult } from "../services/aiProcessor";
import { createGenerateEmbedding } from "../services/embeddings";
import { processContent } from "../worker";
import {
  DiskCache, RESULTS_DIR, EVAL_USER_EMAIL, docLink, embeddingKey, evalDatabaseUrl, evalRedisUrl,
  loadCorpus, loadTestQueries, requireEnv, sha,
} from "./lib";

// Bun and worker.ts's dotenv import load .env. Remove the connection strings so
// nothing in this process can reach them.
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
process.env.DRIZZLE_LOGGER = "false";

const QUEUE = "eval-content-processing";
const CONCURRENCY = 12;

const databaseUrl = evalDatabaseUrl();
const redisUrl = evalRedisUrl();
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0);
const docs = limit ? loadCorpus().slice(0, limit) : loadCorpus();
const queries = limit ? [] : loadTestQueries();

const summaries = new DiskCache<AISummaryResult>("summaries");
const embeddings = new DiskCache<number[]>("embeddings");
const usage = {
  summaryCalls: 0,
  summaryInputTokens: 0,
  summaryOutputTokens: 0,
  embeddingCalls: 0,
  embeddingTokens: 0,
};

// generateEmbedding discards the API's usage block, so read it off the response
// here, without changing what the client sees.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const response = await realFetch(input, init);
  if (String(input?.url ?? input).startsWith("https://api.openai.com/v1/embeddings") && response.ok) {
    const body: any = await response.clone().json();
    usage.embeddingTokens += body.usage?.total_tokens ?? 0;
  }
  return response;
}) as typeof fetch;

// The keys are only needed for cache misses, which is checked after the reset.
let realEmbedding: ReturnType<typeof createGenerateEmbedding> | null = null;
let anthropic: Anthropic | null = null;

function embeddingClient() {
  realEmbedding ??= createGenerateEmbedding(requireEnv("OPENAI_API_KEY"));
  return realEmbedding;
}
function anthropicClient() {
  requireEnv("ANTHROPIC_API_KEY");
  anthropic ??= new Anthropic();
  return anthropic;
}

async function cachedEmbedding(text: string): Promise<number[]> {
  const key = embeddingKey(text);
  const hit = embeddings.get(key);
  if (hit) return hit;
  usage.embeddingCalls++;
  const vector = await embeddingClient()(text);
  if (!vector) throw new Error("embedding call returned null");
  embeddings.set(key, vector);
  return vector;
}

async function cachedSummary(text: string, title: string | null, type: string): Promise<AISummaryResult> {
  const key = sha("summary-v1", text, title, type);
  const hit = summaries.get(key);
  if (hit) return hit;
  const client = anthropicClient();
  // Pass-through that records token usage, around the real client.
  const counting = {
    messages: {
      create: async (params: any) => {
        const response = await client.messages.create(params);
        usage.summaryCalls++;
        usage.summaryInputTokens += (response as any).usage?.input_tokens ?? 0;
        usage.summaryOutputTokens += (response as any).usage?.output_tokens ?? 0;
        return response;
      },
    },
  } as unknown as Anthropic;
  const result = await generateSummaryAndTags(counting, text, title, type);
  summaries.set(key, result);
  return result;
}

async function resetDatabase() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("drop schema public cascade; create schema public; create extension vector");
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  for (const statement of statements) await client.query(statement);
  await client.end();
}

async function main() {
  console.log(`corpus ${docs.length} docs, ${queries.length} test queries`);
  console.log(`cache: ${summaries.size} summaries, ${embeddings.size} embeddings`);

  // Fail before any work if a call cannot succeed.
  if (summaries.size < docs.length || embeddings.size < docs.length + queries.length) {
    // (with a partial cache from an earlier run this also runs; both probes are cheap)
    requireEnv("OPENAI_API_KEY");
    requireEnv("ANTHROPIC_API_KEY");
    const probe = await embeddingClient()("connectivity probe");
    if (!probe) {
      console.error("STOP: the OpenAI embedding probe failed (see the error above).");
      process.exit(3);
    }
    if (probe.length !== 1536) {
      console.error(`STOP: expected 1536 dimensions, got ${probe.length}.`);
      process.exit(3);
    }
    try {
      await anthropicClient().messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 5,
        messages: [{ role: "user", content: "ping" }],
      });
    } catch (err) {
      console.error(`STOP: the Anthropic probe failed: ${(err as Error).message}`);
      process.exit(3);
    }
  }

  await resetDatabase();
  const db = createDb(databaseUrl) as unknown as Db & { $client: pg.Pool };
  const [user] = await db
    .insert(users)
    .values({ username: "scifact-eval", email: EVAL_USER_EMAIL, password: "not-a-login" })
    .returning();

  const ids: string[] = [];
  for (let i = 0; i < docs.length; i += 500) {
    const batch = docs.slice(i, i + 500).map((d) => ({
      userId: user!.id,
      link: docLink(d._id),
      title: d.title,
      ogTitle: d.title,
      type: "article" as const,
      extractedText: d.text,
      processingStatus: "pending" as const,
    }));
    const inserted = await db.insert(contents).values(batch).returning({ id: contents.id });
    ids.push(...inserted.map((r) => r.id));
  }
  console.log(`inserted ${ids.length} pending rows`);

  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(QUEUE, {
    connection: connection as any,
    defaultJobOptions: {
      attempts: 6,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
  await queue.obliterate({ force: true });

  // processContent logs a line per document; keep the output readable.
  const log = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[Worker]")) return;
    log(...args);
  };

  const started = performance.now();
  let completed = 0;
  let failed = 0;
  const failures: string[] = [];
  const done = Promise.withResolvers<void>();
  const settle = () => {
    if (completed + failed === ids.length) done.resolve();
  };

  const worker = new Worker(
    QUEUE,
    (job) =>
      processContent(job as any, {
        db,
        generateSummaryAndTags: cachedSummary,
        generateEmbedding: cachedEmbedding,
      }),
    { connection: connection.duplicate({ maxRetriesPerRequest: null }) as any, concurrency: CONCURRENCY },
  );
  worker.on("completed", () => {
    completed++;
    if (completed % 250 === 0) {
      log(`${completed}/${ids.length} done, ${((performance.now() - started) / 1000).toFixed(0)}s, usage ${JSON.stringify(usage)}`);
    }
    settle();
  });
  worker.on("failed", (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      failed++;
      failures.push(`${job.data.contentId}: ${err.message}`);
      settle();
    } else {
      log(`retrying ${job?.data.contentId}: ${err.message.slice(0, 160)}`);
    }
  });

  for (let i = 0; i < ids.length; i += 1000) {
    await queue.addBulk(
      ids.slice(i, i + 1000).map((contentId) => ({ name: "process-content", data: { contentId } })),
    );
  }

  await done.promise;
  await worker.close();
  await queue.close();
  connection.disconnect();
  console.log = log;

  // Query embeddings, through the same client and cache.
  for (let i = 0; i < queries.length; i += 8) {
    await Promise.all(queries.slice(i, i + 8).map((q) => cachedEmbedding(q.text)));
  }

  await db.execute(sql`vacuum analyze contents`);

  const statsResult: any = await db.execute(sql`
      select count(*)::int as rows,
        count(*) filter (where processing_status = 'done')::int as done,
        count(embedding)::int as with_embedding,
        count(*) filter (where cardinality(tags) = 0)::int as without_tags,
        count(*) filter (where summary is null)::int as without_summary,
        percentile_disc(0.5) within group (order by length(summary))::int as median_summary_chars
      from contents`);
  const stats = statsResult.rows[0];

  const seconds = (performance.now() - started) / 1000;
  const report = {
    ...stats,
    seconds: Number(seconds.toFixed(1)),
    workerConcurrency: CONCURRENCY,
    uncachedCallsThisRun: usage,
    failedJobs: failures.length,
    failures: failures.slice(0, 20),
    cachedSummaries: summaries.size,
    cachedEmbeddings: embeddings.size,
  };
  console.log(JSON.stringify(report, null, 2));

  // Rerunning from a full cache must not erase the record of the paid run.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(
    RESULTS_DIR,
    limit ? "ingest-stats-dry-run.json" : usage.summaryCalls > 0 ? "ingest-stats.json" : "ingest-stats-rerun.json",
  );
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");

  await db.$client.end();

  if (stats.done !== docs.length || stats.with_embedding !== docs.length) {
    console.error(`STOP: incomplete ingest (${stats.done} done, ${stats.with_embedding} embedded of ${docs.length}).`);
    process.exit(4);
  }
  process.exit(0);
}

await main();
