import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { contents, users, type NewContent } from "../db/schema";
import { processContent, type WorkerDeps } from "../worker";
import { createTestDb, oneHot, type TestDb } from "../test/helpers/db";

let t: TestDb;
let userId: string;
const TEXT = "Hippocampal neurons respond to spatial cues during navigation. ".repeat(4).trim();

const job = (contentId: string, attemptsMade = 0) => ({ data: { contentId }, attemptsMade });

async function insert(values: Partial<Omit<NewContent, "userId">>) {
  const [row] = await t.db
    .insert(contents)
    .values({ link: "https://example.org/paper", type: "article", ...values, userId })
    .returning();
  return row!;
}

async function reload(id: string) {
  const [row] = await t.db.select().from(contents).where(eq(contents.id, id));
  return row!;
}

function deps(overrides: Partial<WorkerDeps> = {}) {
  const generateSummaryAndTags = vi.fn(async () => ({ summary: "Short summary.", tags: ["science"] }));
  const generateEmbedding = vi.fn(async (_text: string): Promise<number[] | null> => oneHot(3));
  return {
    generateSummaryAndTags,
    generateEmbedding,
    all: { db: t.db, generateSummaryAndTags, generateEmbedding, ...overrides } as WorkerDeps,
  };
}

beforeAll(async () => {
  t = await createTestDb();
  const [user] = await t.db.insert(users).values({ username: "u", email: "u@example.org", password: "x" }).returning();
  userId = user!.id;
});

afterAll(async () => {
  await t.close();
});

describe("processContent (embedding and summarizer mocked)", () => {
  it("embeds title + summary + text, stores the result and marks the row done", async () => {
    const row = await insert({ title: "Place cells", extractedText: TEXT });
    const d = deps();

    await processContent(job(row.id), d.all);

    expect(d.generateEmbedding).toHaveBeenCalledExactlyOnceWith(`Place cells\n\nShort summary.\n\n${TEXT}`);
    expect(await reload(row.id)).toMatchObject({
      processingStatus: "done",
      summary: "Short summary.",
      tags: ["science"],
      embedding: oneHot(3),
    });
  });

  it("the summary becomes searchable: search_vector is regenerated from it", async () => {
    const row = await insert({ title: "Untitled", extractedText: TEXT });
    const d = deps();
    d.generateSummaryAndTags.mockResolvedValueOnce({ summary: "Zebrafish regeneration.", tags: [] });

    await processContent(job(row.id), d.all);

    const { rows } = await t.client.query<{ hit: boolean }>(
      `select search_vector @@ to_tsquery('english', 'zebrafish') as hit from contents where id = $1`,
      [row.id],
    );
    expect(rows[0]!.hit).toBe(true);
  });

  it("only the first 2000 characters of the text go into the embedding input", async () => {
    const longText = "x".repeat(5000);
    const row = await insert({ title: "T", extractedText: longText });
    const d = deps();

    await processContent(job(row.id), d.all);

    expect(d.generateEmbedding.mock.calls[0]![0]).toBe(`T\n\nShort summary.\n\n${"x".repeat(2000)}`);
  });

  it("falls back to ogTitle when there is no title", async () => {
    const row = await insert({ ogTitle: "From OG", extractedText: TEXT });
    const d = deps();

    await processContent(job(row.id), d.all);

    expect(d.generateEmbedding.mock.calls[0]![0].startsWith("From OG\n\n")).toBe(true);
  });

  it("marks done without AI calls when there is too little text", async () => {
    const row = await insert({ ogTitle: "Hi" });
    const d = deps();

    await processContent(job(row.id), d.all);

    expect(d.generateSummaryAndTags).not.toHaveBeenCalled();
    expect(d.generateEmbedding).not.toHaveBeenCalled();
    expect((await reload(row.id)).processingStatus).toBe("done");
  });

  it("skips a job whose row was deleted", async () => {
    const d = deps();
    await processContent(job("00000000-0000-4000-8000-000000000000"), d.all);
    expect(d.generateSummaryAndTags).not.toHaveBeenCalled();
  });

  it("KNOWN BUG: a failed embedding still ends 'done', with no embedding and no retry", async () => {
    const row = await insert({ title: "No vector", extractedText: TEXT });
    const d = deps();
    d.generateEmbedding.mockResolvedValueOnce(null);

    await expect(processContent(job(row.id), d.all)).resolves.toBeUndefined();

    const after = await reload(row.id);
    expect(after.processingStatus).toBe("done");
    expect(after.embedding).toBeNull();
  });

  it("an embedding that throws rejects the job so BullMQ can retry, leaving 'processing'", async () => {
    const row = await insert({ title: "Throws", extractedText: TEXT });
    const d = deps();
    d.generateEmbedding.mockRejectedValueOnce(new Error("boom"));

    await expect(processContent(job(row.id), d.all)).rejects.toThrow("boom");
    expect((await reload(row.id)).processingStatus).toBe("processing");
  });

  it("a retry after a failure completes the row", async () => {
    const row = await insert({ title: "Retry", extractedText: TEXT });
    const d = deps();
    d.generateEmbedding.mockRejectedValueOnce(new Error("boom"));

    await expect(processContent(job(row.id, 0), d.all)).rejects.toThrow();
    await processContent(job(row.id, 1), d.all);

    expect((await reload(row.id)).processingStatus).toBe("done");
  });

  it("an embedding of the wrong dimension rejects at the database update", async () => {
    const row = await insert({ title: "Wrong dims", extractedText: TEXT });
    const d = deps();
    d.generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);

    await expect(processContent(job(row.id), d.all)).rejects.toThrow();
    expect((await reload(row.id)).processingStatus).toBe("processing");
  });
});
