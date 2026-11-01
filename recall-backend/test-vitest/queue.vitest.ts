// A real BullMQ worker on local Redis (eval/local-services.sh start), to prove
// that a failed embedding actually gets retried by the queue, and that the row
// ends up failed if it never succeeds.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, QueueEvents, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";
import { contents, users } from "../db/schema";
import { processContent, type WorkerDeps } from "../worker";
import { createTestDb, oneHot, type TestDb } from "../test/helpers/db";

const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:63799";
if (new URL(REDIS_URL).hostname !== "127.0.0.1") throw new Error("TEST_REDIS_URL must be loopback");

const TEXT = "Long enough body text for the worker to process it. ".repeat(3).trim();
const QUEUE = "vitest-content-processing";

let t: TestDb;
let userId: string;
let connection: IORedis;
let queue: Queue;
let events: QueueEvents;
let worker: Worker;
let embeddingResults: Array<number[] | null>;
let embeddingCalls = 0;

beforeAll(async () => {
  t = await createTestDb();
  const [u] = await t.db.insert(users).values({ username: "q", email: "q@example.org", password: "x" }).returning();
  userId = u!.id;

  connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(QUEUE, { connection: connection as any });
  await queue.obliterate({ force: true });
  events = new QueueEvents(QUEUE, { connection: connection.duplicate({ maxRetriesPerRequest: null }) as any });
  await events.waitUntilReady();

  const deps: WorkerDeps = {
    db: t.db,
    generateSummaryAndTags: async () => ({ summary: "S", tags: [] }),
    generateEmbedding: async () => {
      embeddingCalls++;
      return embeddingResults.shift() ?? null;
    },
  };
  worker = new Worker(QUEUE, (job) => processContent(job as any, deps), {
    connection: connection.duplicate({ maxRetriesPerRequest: null }) as any,
  });
});

afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.close();
  connection.disconnect();
  await t.close();
});

async function enqueue(link: string) {
  const [row] = await t.db.insert(contents).values({ userId, link, title: "T", extractedText: TEXT }).returning();
  const job = await queue.add("process-content", { contentId: row!.id }, { attempts: 2, backoff: { type: "fixed", delay: 10 } });
  return { id: row!.id, job };
}

const reload = async (id: string) => (await t.db.select().from(contents).where(eq(contents.id, id)))[0]!;

describe("failed embeddings through BullMQ", () => {
  it("retries, and the second attempt completes the row", async () => {
    embeddingCalls = 0;
    embeddingResults = [null, oneHot(1)];
    const { id, job } = await enqueue("https://example.org/retry");

    await job.waitUntilFinished(events, 20_000);

    expect(embeddingCalls).toBe(2);
    expect((await reload(id)).processingStatus).toBe("done");
  });

  it("ends failed, with the job in the failed set, when every attempt fails", async () => {
    embeddingCalls = 0;
    embeddingResults = [null, null];
    const { id, job } = await enqueue("https://example.org/exhausted");

    await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow("Embedding failed");

    expect(embeddingCalls).toBe(2);
    const row = await reload(id);
    expect(row.processingStatus).toBe("failed");
    expect(row.embedding).toBeNull();
  });
});
