// Characterization tests for the injectable AI and embedding clients:
// generateSummaryAndTags with a fake Anthropic client, createGenerateEmbedding
// with a stubbed fetch, and the chat route with a fake Anthropic stream.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { contents } from "../db/schema";
import { generateSummaryAndTags } from "../services/aiProcessor";
import { createGenerateEmbedding } from "../services/embeddings";
import { createTestApp, fakeAnthropic, type TestApp } from "./helpers/app";
import { restoreFetch, stubFetch } from "./helpers/network";

afterEach(() => {
  restoreFetch();
});

describe("generateSummaryAndTags", () => {
  test("asks Haiku for JSON and returns the parsed summary with at most 3 string tags", async () => {
    const fake = fakeAnthropic({
      createText: '```json\n{"summary": "Short summary.", "tags": ["ai", 7, "ml", "tech", "tools"]}\n```',
    });

    const result = await generateSummaryAndTags(fake.anthropic, "x".repeat(5000), null, "article");

    expect(result).toEqual({ summary: "Short summary.", tags: ["ai", "ml", "tech"] });

    expect(fake.createCalls).toHaveLength(1);
    const params = fake.createCalls[0];
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.max_tokens).toBe(300);
    expect(params.messages).toHaveLength(1);
    const prompt: string = params.messages[0].content;
    expect(prompt).toContain("Analyze this article content");
    expect(prompt).toContain("Title: Untitled");
    // the text is cut to 4000 characters
    expect(prompt).toContain(`\n${"x".repeat(4000)}\n`);
    expect(prompt).not.toContain("x".repeat(4001));
  });

  test("a non-JSON reply becomes the summary (first 500 chars) with no tags", async () => {
    const reply = "Sorry, I cannot do that. ".repeat(40);
    const fake = fakeAnthropic({ createText: reply });

    const result = await generateSummaryAndTags(fake.anthropic, "some text", "A title", "link");

    expect(result).toEqual({ summary: reply.slice(0, 500), tags: [] });
  });

  test("JSON without the expected fields falls back to placeholder values", async () => {
    const fake = fakeAnthropic({ createText: '{"summary": 42, "tags": "ai"}' });

    const result = await generateSummaryAndTags(fake.anthropic, "some text", "A title", "link");

    expect(result).toEqual({ summary: "No summary available.", tags: [] });
  });
});

describe("createGenerateEmbedding", () => {
  test("without an API key it returns null and never calls fetch", async () => {
    const calls = stubFetch(() => new Response("{}"));
    const generateEmbedding = createGenerateEmbedding("");

    expect(await generateEmbedding("hello")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("posts the text (cut to 30,000 chars) to OpenAI and returns the vector", async () => {
    const calls = stubFetch(() => Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    const generateEmbedding = createGenerateEmbedding("sk-test");

    expect(await generateEmbedding("y".repeat(40_000))).toEqual([0.1, 0.2, 0.3]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]!.init!.method).toBe("POST");
    expect(calls[0]!.init!.headers).toEqual({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      model: "text-embedding-3-small",
      input: "y".repeat(30_000),
    });
  });

  test("an API error or a network failure returns null instead of throwing", async () => {
    const generateEmbedding = createGenerateEmbedding("sk-test");

    stubFetch(() => new Response("quota exceeded", { status: 429 }));
    expect(await generateEmbedding("hello")).toBeNull();

    stubFetch(() => {
      throw new Error("socket hang up");
    });
    expect(await generateEmbedding("hello")).toBeNull();
  });
});

describe("POST /api/v1/chat", () => {
  let t: TestApp;
  let ada: { userId: string; token: string };

  beforeAll(async () => {
    t = await createTestApp({ anthropic: fakeAnthropic({ streamText: ["Hello", " world"] }) });
    ada = await t.createUser("ada");
    await t.db.insert(contents).values({
      userId: ada.userId,
      link: "https://a.example",
      title: "Postgres indexing guide",
      type: "article",
      summary: "About indexes.",
    });
  });

  afterAll(async () => {
    await t.close();
  });

  test("requires a message", async () => {
    const res = await t.request("POST", "/api/v1/chat", { token: ada.token, body: {} });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Message is required" });
  });

  test("streams citations, the model's text and a done event as SSE", async () => {
    // the fake embedding returns null, so the route falls back to the 5 most recent rows
    const res = await t.request("POST", "/api/v1/chat", {
      token: ada.token,
      body: {
        message: "what do I have on postgres?",
        history: [
          { role: "user", content: "hi" },
          { role: "system", content: "dropped: only user/assistant are kept" },
          { role: "assistant", content: "hello" },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = res.text
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
    expect(events).toEqual([
      {
        type: "citations",
        citations: [
          {
            index: 1,
            id: expect.any(String),
            title: "Postgres indexing guide",
            link: "https://a.example",
            type: "article",
          },
        ],
      },
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "done" },
    ]);

    expect(t.anthropic.streamCalls).toHaveLength(1);
    const params = t.anthropic.streamCalls[0];
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.max_tokens).toBe(2000);
    expect(params.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what do I have on postgres?" },
    ]);
    expect(params.system).toStartWith(
      "You are Recall AI, a helpful assistant that answers questions based on the user's saved links and content.",
    );
    expect(params.system).toEndWith(
      'USER\'S SAVED CONTENT:\n[1] "Postgres indexing guide" (article)\nURL: https://a.example\nAbout indexes.',
    );
  });
});
