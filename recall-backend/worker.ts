

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

interface ContentJobData {
  contentId: string;
}

async function processContent(job: Job<ContentJobData>) {
  const { contentId } = job.data;

  console.log(`[Worker] Processing content ${contentId} (attempt ${job.attemptsMade + 1})`);

  
  const [content] = await db
    .select()
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);

  if (!content) {
    console.log(`[Worker] Content ${contentId} not found — skipping`);
    return; 
  }

  
  await db
    .update(contents)
    .set({ processingStatus: "processing" })
    .where(eq(contents.id, contentId));

  
  
  const detection = detectLinkType(content.link);
  const { text } = await extractText(
    detection.type,
    content.link,
    content.extractedText,   
    detection.embedData
  );

  
  
  const fullText = [
    content.ogTitle && `Title: ${content.ogTitle}`,
    content.ogDescription && `Description: ${content.ogDescription}`,
    text && `Content: ${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!fullText || fullText.length < 20) {
    
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

  
  const aiResult = await generateSummaryAndTags(
    fullText,
    content.title ?? content.ogTitle,
    content.type
  );

  
  
  
  
  const embeddingInput = [
    content.title ?? content.ogTitle ?? "",
    aiResult.summary,
    (text ?? "").slice(0, 2000),  
  ].join("\n\n");

  const embedding = await generateEmbedding(embeddingInput);

  
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

const worker = new Worker<ContentJobData>(
  "content-processing",     
  processContent,
  {
    connection: redisConnection,
    concurrency: 3,         
    
    
    
  }
);

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 3)) {
    console.error(`[Worker] Job ${job.id} exhausted all retries — moving to DLQ`);
    
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

process.on("SIGINT", async () => {
  console.log("\n[Worker] Shutting down gracefully...");
  await worker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
