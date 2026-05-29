// ─── Content Processing Worker ──────────────────────────────────
// This file runs as a SEPARATE PROCESS from the Express server.
// Start it with: bun run worker.ts
//
// Architecture:
//   Terminal 1: bun run index.ts     (Express API server)
//   Terminal 2: bun run worker.ts    (this file — BullMQ worker)
//   Background: Redis server          (BullMQ's message broker)
//   Background: PostgreSQL            (shared database)
//
// The worker listens on the "content-processing" queue and processes
// each job through a pipeline:
//
//   1. Read content from DB
//   2. Extract text (YouTube transcript, GitHub README, etc.)
//   3. Generate summary + tags via Claude API
//   4. Write results back to DB
//   5. (Day 3) Generate vector embedding for semantic search
//
// Why a separate process?
// - Claude API calls take 2-5 seconds each
// - If this ran inside Express, API requests would be delayed
// - Separate process means the API stays responsive (<100ms)
// - Worker can crash/restart without affecting the API
// - You can scale workers independently (run 3 workers on heavy load)

import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "./config/db";
import { contents } from "./db/schema";
import { redisConnection } from "./config/queue";
import { detectLinkType } from "./services/linkDetector";
import { extractText } from "./services/textExtractor";
import { generateSummaryAndTags } from "./services/aiProcessor";
import { generateEmbedding } from "./services/embeddings";

// ── Job payload type ──
// This is what the Express server puts into the queue when a link is saved.
interface ContentJobData {
  contentId: string;
}

// ── Process a single content item ──
async function processContent(job: Job<ContentJobData>) {
  const { contentId } = job.data;

  console.log(`[Worker] Processing content ${contentId} (attempt ${job.attemptsMade + 1})`);

  // Step 1: Read the content from the database
  const [content] = await db
    .select()
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);

  if (!content) {
    console.log(`[Worker] Content ${contentId} not found — skipping`);
    return; // Don't retry — the content was deleted
  }

  // Mark as processing so the frontend shows a loading indicator
  await db
    .update(contents)
    .set({ processingStatus: "processing" })
    .where(eq(contents.id, contentId));

  // Step 2: Extract text
  // Re-detect the link type to get embedData (videoId, owner, repo, etc.)
  const detection = detectLinkType(content.link);
  const { text } = await extractText(
    detection.type,
    content.link,
    content.extractedText,   // might already have article text from Readability
    detection.embedData
  );

  // Build the full text to summarize: combine OG metadata with extracted text
  // This gives Claude more context for a better summary
  const fullText = [
    content.ogTitle && `Title: ${content.ogTitle}`,
    content.ogDescription && `Description: ${content.ogDescription}`,
    text && `Content: ${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!fullText || fullText.length < 20) {
    // Not enough text to summarize — mark as done without summary
    console.log(`[Worker] Not enough text for ${contentId} — marking done`);
    await db
      .update(contents)
      .set({
        extractedText: text,
        processingStatus: "done",
      })
      .where(eq(contents.id, contentId));
    return;
  }

  // Step 3: Generate summary + tags via Claude API
  const aiResult = await generateSummaryAndTags(
    fullText,
    content.title ?? content.ogTitle,
    content.type
  );

  // Step 4: Generate vector embedding for semantic search (Day 3)
  // We embed the title + summary + a chunk of the content.
  // Title gives topic signal, summary gives Claude's understanding,
  // content gives raw detail. This mix gives the best search results.
  const embeddingInput = [
    content.title ?? content.ogTitle ?? "",
    aiResult.summary,
    (text ?? "").slice(0, 2000),  // first 2K chars of content
  ].join("\n\n");

  const embedding = await generateEmbedding(embeddingInput);

  // Step 5: Write everything back to the database
  await db
    .update(contents)
    .set({
      extractedText: text,
      summary: aiResult.summary,
      tags: aiResult.tags,
      ...(embedding && { embedding }),
      processingStatus: "done",
      updatedAt: new Date(),
    })
    .where(eq(contents.id, contentId));

  console.log(
    `[Worker] ✓ Content ${contentId} processed — summary: ${aiResult.summary.slice(0, 60)}... tags: [${aiResult.tags.join(", ")}] embedding: ${embedding ? "yes" : "skipped"}`
  );
}

// ─── Start the worker ───────────────────────────────────────────
const worker = new Worker<ContentJobData>(
  "content-processing",     // Must match the queue name in config/queue.ts
  processContent,
  {
    connection: redisConnection,
    concurrency: 3,         // Process up to 3 jobs in parallel
    // ^ Why 3? Claude API calls are I/O-bound (waiting for network),
    // not CPU-bound. Running 3 in parallel means better throughput
    // without overwhelming the API rate limit.
  }
);

// ── Event handlers for monitoring ──
worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    console.error(`[Worker] Job ${job.id} exhausted all retries — moving to DLQ`);
    // Mark the content as failed in the DB so the frontend shows an error state
    db.update(contents)
      .set({ processingStatus: "failed" })
      .where(eq(contents.id, job.data.contentId))
      .catch(console.error);
  }
});

worker.on("error", (err) => {
  console.error("[Worker] Worker error:", err);
});

console.log("[Worker] Content processing worker started — waiting for jobs...");
console.log("[Worker] Press Ctrl+C to stop");

// ── Graceful shutdown ──
// When you Ctrl+C, close the worker cleanly so in-progress jobs
// aren't abandoned (they'd retry otherwise).
process.on("SIGINT", async () => {
  console.log("\n[Worker] Shutting down gracefully...");
  await worker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});