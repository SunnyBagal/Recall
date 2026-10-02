import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { createApp } from "../../index";
import type { ContentQueue } from "../../config/queue";
import type { AnthropicClient, GenerateSummaryAndTags } from "../../services/aiProcessor";
import type { GenerateEmbedding } from "../../services/embeddings";
import { users } from "../../db/schema";
import { createTestDb, type TestDb } from "./db";

// ---- fakes -----------------------------------------------------------------

export interface QueueCall {
  name: string;
  data: { contentId: string };
  opts: { delay?: number } | undefined;
}

export function fakeQueue() {
  const calls: QueueCall[] = [];
  const queue: ContentQueue = {
    async add(name, data, opts) {
      calls.push({ name, data, opts });
    },
  };
  return { queue, calls };
}

/**
 * Embedding fake: returns whatever `byText` maps the input to, otherwise
 * `fallback` (null by default, which is what the real one returns when
 * OPENAI_API_KEY is unset).
 */
export function fakeEmbedding(fallback: number[] | null = null) {
  const byText = new Map<string, number[] | null>();
  const calls: string[] = [];
  const generateEmbedding: GenerateEmbedding = async (text) => {
    calls.push(text);
    return byText.has(text) ? byText.get(text)! : fallback;
  };
  return { generateEmbedding, byText, calls };
}

export function fakeSummarizer(result = { summary: "A fake summary.", tags: ["tech", "ai"] }) {
  const calls: Array<{ text: string; title: string | null; contentType: string }> = [];
  const generateSummaryAndTags: GenerateSummaryAndTags = async (text, title, contentType) => {
    calls.push({ text, title, contentType });
    return result;
  };
  return { generateSummaryAndTags, calls };
}

/**
 * Anthropic client fake covering the two calls the backend makes:
 * messages.create (aiProcessor) and messages.stream (the chat route).
 */
export function fakeAnthropic(opts: { createText?: string; streamText?: string[] } = {}) {
  const createCalls: any[] = [];
  const streamCalls: any[] = [];
  let aborted = 0;

  const messages = {
    async create(params: any) {
      createCalls.push(params);
      return { content: [{ type: "text", text: opts.createText ?? "" }] };
    },
    stream(params: any) {
      streamCalls.push(params);
      return {
        abort() {
          aborted++;
        },
        async *[Symbol.asyncIterator]() {
          for (const text of opts.streamText ?? []) {
            yield { type: "content_block_delta", delta: { type: "text_delta", text } };
          }
        },
      };
    },
  };

  return {
    anthropic: { messages } as unknown as AnthropicClient,
    createCalls,
    streamCalls,
    abortCount: () => aborted,
  };
}

// ---- app -------------------------------------------------------------------

export interface TestApp extends TestDb {
  baseUrl: string;
  queue: ReturnType<typeof fakeQueue>;
  embedding: ReturnType<typeof fakeEmbedding>;
  anthropic: ReturnType<typeof fakeAnthropic>;
  /** Insert a user directly and return its id and a valid token. */
  createUser(username: string): Promise<{ userId: string; token: string }>;
  request(
    method: string,
    path: string,
    opts?: { token?: string; body?: unknown },
  ): Promise<{ status: number; body: any; headers: Headers; text: string }>;
  close(): Promise<void>;
}

/**
 * The real app (createApp from index.ts) on a PGlite database with fake queue,
 * embedding and Anthropic clients, listening on an ephemeral loopback port.
 */
export async function createTestApp(
  fakes: { anthropic?: ReturnType<typeof fakeAnthropic> } = {},
): Promise<TestApp> {
  const testDb = await createTestDb();
  const queue = fakeQueue();
  const embedding = fakeEmbedding();
  const anthropic = fakes.anthropic ?? fakeAnthropic();

  const app = createApp({
    db: testDb.db,
    queue: queue.queue,
    generateEmbedding: embedding.generateEmbedding,
    anthropic: anthropic.anthropic,
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    ...testDb,
    baseUrl,
    queue,
    embedding,
    anthropic,

    async createUser(username) {
      const [user] = await testDb.db
        .insert(users)
        .values({ username, email: `${username}@example.com`, password: "not-a-real-hash" })
        .returning();
      const userId = user!.id;
      // Same payload the signin route signs.
      const token = jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: "24h" });
      return { userId, token };
    },

    async request(method, path, opts = {}) {
      const headers: Record<string, string> = {};
      // The API expects the raw token in Authorization (no "Bearer " prefix).
      if (opts.token) headers.Authorization = opts.token;
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(baseUrl + path, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let body: any = undefined;
      try {
        body = JSON.parse(text);
      } catch {
        // not JSON (e.g. the SSE chat stream) — use `text`
      }
      return { status: res.status, body, headers: res.headers, text };
    },

    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await testDb.close();
    },
  };
}
