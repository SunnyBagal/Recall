import { Queue } from "bullmq";
import IORedis from "ioredis";

// The only part of the queue the API uses. Production passes the BullMQ queue
// from createQueue(); tests pass a fake.
export interface ContentQueue {
  add(name: string, data: { contentId: string }, opts?: { delay?: number }): Promise<unknown>;
}

// Called by the entry points (index.ts, worker.ts) — importing this module no
// longer connects to Redis.
export function createQueue() {
  const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

  const redisConnection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const contentQueue = new Queue("content-processing", {
    connection: redisConnection as any,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  });

  console.log("[Queue] Content processing queue initialized");

  return { redisConnection, contentQueue };
}
