// ─── BullMQ Queue Configuration ─────────────────────────────────
// BullMQ uses Redis as its backing store. The queue is the communication
// channel between two separate processes:
//
//   Express server (producer)  →  Redis  →  Worker (consumer)
//
// Why separate processes?
// If the worker runs inside the Express server, a CPU-heavy job
// (like calling Claude API) blocks the event loop and makes your
// API unresponsive. Running the worker in a separate process means
// your API stays fast while heavy processing happens in the background.
//
// Interview explanation:
// "When a user saves a URL, the API responds immediately. It then pushes
// a job to a Redis-backed BullMQ queue. A separate worker process picks
// up the job, extracts text, calls Claude for summarization and tagging,
// and writes the results back to PostgreSQL. The frontend polls until
// the processingStatus changes from 'pending' to 'done', then displays
// the summary and tags. If the worker crashes, BullMQ retries with
// exponential backoff, and after 3 failures the job goes to a dead
// letter queue for investigation."

import { Queue } from "bullmq";
import IORedis from "ioredis";

// ── Redis connection ──
// Shared between the queue (producer-side) and the worker (consumer-side).
// BullMQ needs a dedicated Redis connection — don't share it with
// session storage or caching.
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,  // Required by BullMQ — it manages retries itself
});

// ── Content processing queue ──
// Every new content item gets a job added to this queue.
// The worker picks up jobs and runs: text extraction → summary → tags → embedding.
export const contentQueue = new Queue("content-processing", {
  // Cast: bullmq ships ioredis@5.10.1, project has 5.11.0 — same shape,
  // different node_modules paths. See package.json fix below.
  connection: redisConnection as any,
  defaultJobOptions: {
    // ── Retry configuration ──
    attempts: 3,                     // Try up to 3 times
    backoff: {
      type: "exponential",           // Wait longer between each retry
      delay: 5000,                   // First retry after 5s, then 10s, then 20s
    },
    // ── Dead letter queue ──
    // After all retries fail, the job moves here instead of disappearing.
    // You can inspect failed jobs with `bullmq-dashboard` or Drizzle Studio.
    removeOnComplete: { count: 100 }, // Keep last 100 completed jobs for debugging
    removeOnFail: { count: 200 },     // Keep last 200 failed jobs for investigation
  },
});

console.log("[Queue] Content processing queue initialized");