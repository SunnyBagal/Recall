// Characterization tests: these assert what the worker's job processing does
// today, oddities included — not what it should do. processContent is called
// directly with a fake job; no BullMQ Worker or Redis is involved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { contents, type NewContent } from "../db/schema";
import { processContent, type WorkerDeps } from "../worker";
import { fakeEmbedding, fakeSummarizer } from "./helpers/app";
import { createTestDb, oneHot, type TestDb } from "./helpers/db";
import { users } from "../db/schema";

let t: TestDb;
let userId: string;

const ARTICLE_TEXT = "Indexes speed up reads at the cost of writes. ".repeat(5).trim();

async function insertContent(values: Omit<NewContent, "userId">) {
  const [row] = await t.db.insert(contents).values({ ...values, userId }).returning();
  return row!;
}

async function reload(id: string) {
  const [row] = await t.db.select().from(contents).where(eq(contents.id, id));
  return row!;
}

function fakeDeps(embedding: number[] | null = oneHot(7)) {
  const summarizer = fakeSummarizer({ summary: "Indexes trade write cost for read speed.", tags: ["database", "backend"] });
  const embedder = fakeEmbedding(embedding);
  const deps: WorkerDeps = {
    db: t.db,
    generateSummaryAndTags: summarizer.generateSummaryAndTags,
    generateEmbedding: embedder.generateEmbedding,
  };
  return { deps, summarizer, embedder };
}

const job = (contentId: string) => ({ data: { contentId }, attemptsMade: 0 });

beforeAll(async () => {
  t = await createTestDb();
  const [user] = await t.db
    .insert(users)
    .values({ username: "ada", email: "ada@example.com", password: "x" })
    .returning();
  userId = user!.id;
});

afterAll(async () => {
  await t.close();
});

describe("processContent", () => {
  test("summarizes, tags and embeds a pending row, then marks it done", async () => {
    const row = await insertContent({
      link: "https://dbweekly.example/posts/how-postgres-indexes-work",
      type: "article",
      ogTitle: "How Postgres Indexes Work",
      ogDescription: "A tour of btree and gin.",
      extractedText: ARTICLE_TEXT,
    });
    const { deps, summarizer, embedder } = fakeDeps();

    const result = await processContent(job(row.id), deps);

    expect(result).toBeUndefined();
    expect(summarizer.calls).toEqual([
      {
        text:
          "Title: How Postgres Indexes Work\n\n" +
          "Description: A tour of btree and gin.\n\n" +
          `Content: ${ARTICLE_TEXT}`,
        // row.title is null, so the og title is used
        title: "How Postgres Indexes Work",
        contentType: "article",
      },
    ]);
    expect(embedder.calls).toEqual([
      "How Postgres Indexes Work\n\n" +
        "Indexes trade write cost for read speed.\n\n" +
        ARTICLE_TEXT,
    ]);

    const after = await reload(row.id);
    expect(after).toMatchObject({
      processingStatus: "done",
      summary: "Indexes trade write cost for read speed.",
      tags: ["database", "backend"],
      extractedText: ARTICLE_TEXT,
      embedding: oneHot(7),
    });
    expect(after.updatedAt.getTime()).not.toBe(row.updatedAt.getTime());
  });

  test("when no embedding comes back the row is still marked done, without one", async () => {
    const row = await insertContent({
      link: "https://dbweekly.example/posts/another-long-article-slug",
      type: "article",
      title: "My own title",
      ogTitle: "Og title",
      extractedText: ARTICLE_TEXT,
    });
    const { deps, summarizer } = fakeDeps(null);

    await processContent(job(row.id), deps);

    // row.title wins over ogTitle for the summarizer's title argument
    expect(summarizer.calls[0]!.title).toBe("My own title");
    const after = await reload(row.id);
    expect(after.processingStatus).toBe("done");
    expect(after.summary).toBe("Indexes trade write cost for read speed.");
    expect(after.embedding).toBeNull();
  });

  test("a row with under 20 characters of text is marked done without any AI call", async () => {
    const row = await insertContent({ link: "https://example.com", type: "link", ogTitle: "Hi" });
    const { deps, summarizer, embedder } = fakeDeps();

    await processContent(job(row.id), deps);

    expect(summarizer.calls).toEqual([]);
    expect(embedder.calls).toEqual([]);
    const after = await reload(row.id);
    expect(after).toMatchObject({
      processingStatus: "done",
      summary: null,
      tags: [],
      extractedText: null,
      embedding: null,
    });
    // this branch does not touch updated_at
    expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
  });

  test("a job for a row that no longer exists is skipped", async () => {
    const { deps, summarizer, embedder } = fakeDeps();

    const result = await processContent(job("00000000-0000-4000-8000-000000000000"), deps);

    expect(result).toBeUndefined();
    expect(summarizer.calls).toEqual([]);
    expect(embedder.calls).toEqual([]);
  });

  test("when the summarizer throws, the job rejects and the row stays in 'processing'", async () => {
    const row = await insertContent({
      link: "https://dbweekly.example/posts/yet-another-article-slug",
      type: "article",
      ogTitle: "Og title",
      extractedText: ARTICLE_TEXT,
    });
    const { deps, embedder } = fakeDeps();
    deps.generateSummaryAndTags = async () => {
      throw new Error("anthropic is down");
    };

    await expect(processContent(job(row.id), deps)).rejects.toThrow("anthropic is down");

    expect(embedder.calls).toEqual([]);
    expect((await reload(row.id)).processingStatus).toBe("processing");
  });
});
