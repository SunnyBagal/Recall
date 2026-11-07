import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { createApp } from "../index";
import { contents, users } from "../db/schema";
import { fakeAnthropic, fakeEmbedding, fakeQueue } from "../test/helpers/app";
import { createTestDb, oneHot, type TestDb } from "../test/helpers/db";

vi.mock("../services/metadataFetcher", () => ({
  fetchMetadata: vi.fn(async () => ({
    ogTitle: "Fetched title",
    ogDescription: "Fetched description",
    ogImage: null,
    ogSiteName: "example",
    favicon: null,
    extractedText: "Fetched body text",
  })),
}));

let t: TestDb;
let app: ReturnType<typeof createApp>;
let queue: ReturnType<typeof fakeQueue>;
let embedding: ReturnType<typeof fakeEmbedding>;
let anthropic: ReturnType<typeof fakeAnthropic>;
let counter = 0;

const SECRET = "test-jwt-secret";

async function newUser() {
  const name = `user${++counter}`;
  const [u] = await t.db
    .insert(users)
    .values({ username: name, email: `${name}@example.org`, password: "unused" })
    .returning();
  return { id: u!.id, name, token: jwt.sign({ userId: u!.id }, SECRET, { expiresIn: "1h" }) };
}

const sse = (text: string) =>
  text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, "")));

beforeAll(async () => {
  t = await createTestDb();
  queue = fakeQueue();
  embedding = fakeEmbedding();
  anthropic = fakeAnthropic({ streamText: ["Hello ", "world"] });
  app = createApp({
    db: t.db,
    queue: queue.queue,
    generateEmbedding: embedding.generateEmbedding,
    anthropic: anthropic.anthropic,
  });
});

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  queue.calls.length = 0;
  embedding.calls.length = 0;
  embedding.byText.clear();
  anthropic.streamCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/v1/signup", () => {
  it("creates a user and never stores the plain password", async () => {
    const res = await request(app)
      .post("/api/v1/signup")
      .send({ username: "newbie", email: "newbie@example.org", password: "hunter22" });

    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(users).where(eq(users.id, res.body.userId));
    expect(row!.password).toMatch(/^\$argon2id\$/);
  });

  it.each([
    ["username", { email: "a@example.org", password: "p" }],
    ["email", { username: "a", password: "p" }],
    ["password", { username: "a", email: "a@example.org" }],
  ])("400 when %s is missing", async (_field, body) => {
    const res = await request(app).post("/api/v1/signup").send(body);
    expect(res.status).toBe(400);
  });

  it("400 with no body at all", async () => {
    expect((await request(app).post("/api/v1/signup")).status).toBe(400);
  });

  it("400 on malformed JSON", async () => {
    const res = await request(app)
      .post("/api/v1/signup")
      .set("Content-Type", "application/json")
      .send('{"username":');
    expect(res.status).toBe(400);
  });

  it("409 on a duplicate email", async () => {
    const body = { username: "dup", email: "dup@example.org", password: "p" };
    expect((await request(app).post("/api/v1/signup").send(body)).status).toBe(201);

    const res = await request(app).post("/api/v1/signup").send(body);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: "Email already taken" });
  });
});

describe("POST /api/v1/signin", () => {
  const creds = { username: "signer", email: "signer@example.org", password: "correct horse" };

  beforeAll(async () => {
    await request(app).post("/api/v1/signup").send(creds);
  });

  it("returns a verifiable token when signing in by email", async () => {
    const res = await request(app)
      .post("/api/v1/signin")
      .send({ email: creds.email, password: creds.password });

    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, SECRET)).toHaveProperty("userId");
  });

  it.each([
    ["a username and no email", { username: creds.username, password: creds.password }],
    ["no email", { password: "x" }],
    ["no password", { email: creds.email }],
    ["no body", undefined],
  ])("400 with %s", async (_case, body) => {
    const res = await request(app).post("/api/v1/signin").send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Email and password are required" });
  });

  it("two users with the same username each sign in with their own email", async () => {
    const twins = [
      { username: "twin", email: "twin-a@example.org", password: "password-a" },
      { username: "twin", email: "twin-b@example.org", password: "password-b" },
    ];
    for (const twin of twins) {
      expect((await request(app).post("/api/v1/signup").send(twin)).status).toBe(201);
    }

    for (const { email, password } of twins) {
      const res = await request(app).post("/api/v1/signin").send({ email, password });
      expect(res.status).toBe(200);

      const [row] = await t.db.select().from(users).where(eq(users.email, email));
      expect(jwt.verify(res.body.token, SECRET)).toHaveProperty("userId", row!.id);
    }
  });

  it("401 on a wrong password", async () => {
    const res = await request(app)
      .post("/api/v1/signin")
      .send({ email: creds.email, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("an unknown email and a wrong password get the same 401 and message, so the response does not reveal who exists", async () => {
    const unknown = await request(app)
      .post("/api/v1/signin")
      .send({ email: "ghost@example.org", password: "x" });
    const wrong = await request(app)
      .post("/api/v1/signin")
      .send({ email: creds.email, password: "wrong" });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual({ message: "Invalid credentials" });
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe("auth middleware", () => {
  const protectedRoutes: Array<["get" | "post" | "delete", string]> = [
    ["post", "/api/v1/content"],
    ["get", "/api/v1/content"],
    ["delete", "/api/v1/content"],
    ["post", "/api/v1/brain/share"],
    ["get", "/api/v1/search?q=x"],
    ["post", "/api/v1/chat"],
  ];

  it.each(protectedRoutes)("%s %s is 401 without a token", async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });

  it("401 for a garbage token", async () => {
    const res = await request(app).get("/api/v1/content").set("Authorization", "nope");
    expect(res.status).toBe(401);
  });

  it("401 for a token signed with another secret", async () => {
    const token = jwt.sign({ userId: "x" }, "another-secret");
    expect((await request(app).get("/api/v1/content").set("Authorization", token)).status).toBe(401);
  });

  it("401 for an expired token", async () => {
    const token = jwt.sign({ userId: "x" }, SECRET, { expiresIn: -10 });
    expect((await request(app).get("/api/v1/content").set("Authorization", token)).status).toBe(401);
  });

  it("401 for a valid token with no userId claim", async () => {
    const token = jwt.sign({ sub: "x" }, SECRET);
    const res = await request(app).get("/api/v1/content").set("Authorization", token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ msg: "Unauthorized" });
  });

  it("rejects the standard 'Bearer <token>' form: the raw token is expected", async () => {
    const { token } = await newUser();
    const res = await request(app).get("/api/v1/content").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("alg=none tokens are refused", async () => {
    const token = jwt.sign({ userId: "x" }, "", { algorithm: "none" });
    expect((await request(app).get("/api/v1/content").set("Authorization", token)).status).toBe(401);
  });
});

describe("/api/v1/content", () => {
  it("POST stores fetched metadata as pending and enqueues a delayed job", async () => {
    const { token, id } = await newUser();

    const res = await request(app)
      .post("/api/v1/content")
      .set("Authorization", token)
      .send({ link: "https://example.org/a" });

    expect(res.status).toBe(201);
    expect(queue.calls).toEqual([
      { name: "process-content", data: { contentId: res.body.contentId }, opts: { delay: 1000 } },
    ]);
    const [row] = await t.db.select().from(contents).where(eq(contents.id, res.body.contentId));
    expect(row).toMatchObject({
      userId: id,
      title: "Fetched title",
      extractedText: "Fetched body text",
      processingStatus: "pending",
    });
  });

  it("POST prefers the caller's title over the fetched one", async () => {
    const { token } = await newUser();
    const res = await request(app)
      .post("/api/v1/content")
      .set("Authorization", token)
      .send({ link: "https://example.org/b", title: "Mine" });
    const [row] = await t.db.select().from(contents).where(eq(contents.id, res.body.contentId));
    expect(row!.title).toBe("Mine");
  });

  it("POST 400 without a link, and enqueues nothing", async () => {
    const { token } = await newUser();
    const res = await request(app).post("/api/v1/content").set("Authorization", token).send({});
    expect(res.status).toBe(400);
    expect(queue.calls).toEqual([]);
  });

  it("GET returns only the caller's rows, without extractedText or embedding", async () => {
    const a = await newUser();
    const b = await newUser();
    await t.db.insert(contents).values([
      { userId: a.id, link: "https://a.example", title: "A's", extractedText: "secret", embedding: oneHot(1) },
      { userId: b.id, link: "https://b.example", title: "B's" },
    ]);

    const res = await request(app).get("/api/v1/content").set("Authorization", a.token);

    expect(res.status).toBe(200);
    expect(res.body.content.map((c: any) => c.title)).toEqual(["A's"]);
    expect(res.body.content[0]).not.toHaveProperty("extractedText");
    expect(res.body.content[0]).not.toHaveProperty("embedding");
  });

  it("DELETE removes the caller's row", async () => {
    const a = await newUser();
    const [row] = await t.db.insert(contents).values({ userId: a.id, link: "https://x.example" }).returning();

    const res = await request(app)
      .delete("/api/v1/content")
      .set("Authorization", a.token)
      .send({ contentId: row!.id });

    expect(res.status).toBe(200);
    expect(await t.db.select().from(contents).where(eq(contents.id, row!.id))).toEqual([]);
  });

  it("DELETE is a 404 for another user's row and leaves it in place", async () => {
    const a = await newUser();
    const b = await newUser();
    const [row] = await t.db.insert(contents).values({ userId: a.id, link: "https://y.example" }).returning();

    const res = await request(app)
      .delete("/api/v1/content")
      .set("Authorization", b.token)
      .send({ contentId: row!.id });

    expect(res.status).toBe(404);
    expect(await t.db.select().from(contents).where(eq(contents.id, row!.id))).toHaveLength(1);
  });

  it("KNOWN BUG: DELETE with a malformed contentId is a 500, not a 400", async () => {
    const a = await newUser();
    const res = await request(app)
      .delete("/api/v1/content")
      .set("Authorization", a.token)
      .send({ contentId: "not-a-uuid" });
    expect(res.status).toBe(500);
  });
});

describe("/api/v1/brain", () => {
  it("POST creates a hash and is idempotent", async () => {
    const a = await newUser();
    const first = await request(app).post("/api/v1/brain/share").set("Authorization", a.token).send({ share: true });
    const second = await request(app).post("/api/v1/brain/share").set("Authorization", a.token).send({ share: true });
    expect(first.body.hash).toHaveLength(12);
    expect(second.body.hash).toBe(first.body.hash);
  });

  it("share=false revokes the link", async () => {
    const a = await newUser();
    const { body } = await request(app).post("/api/v1/brain/share").set("Authorization", a.token).send({ share: true });
    await request(app).post("/api/v1/brain/share").set("Authorization", a.token).send({ share: false });
    expect((await request(app).get(`/api/v1/brain/${body.hash}`)).status).toBe(404);
  });

  it("GET is a 404 for an unknown hash", async () => {
    expect((await request(app).get("/api/v1/brain/nothing-here")).status).toBe(404);
  });

  it("regression: the public share view never returns userId, extractedText or embeddings", async () => {
    const a = await newUser();
    await t.db.insert(contents).values({
      userId: a.id,
      link: "https://z.example",
      extractedText: "private page text",
      embedding: oneHot(5),
    });
    const { body } = await request(app).post("/api/v1/brain/share").set("Authorization", a.token).send({ share: true });

    const res = await request(app).get(`/api/v1/brain/${body.hash}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(a.name);
    expect(res.body.content).toHaveLength(1);
    for (const field of ["userId", "extractedText", "embedding", "searchVector", "updatedAt", "createdAt"]) {
      expect(res.body.content[0]).not.toHaveProperty(field);
    }
    // Checked on the raw bytes too, so a differently named field cannot carry them.
    expect(res.text).not.toContain(a.id);
    expect(res.text).not.toContain("private page text");
  });
});

describe("GET /api/v1/search", () => {
  it.each([["no q", "/api/v1/search"], ["blank q", "/api/v1/search?q=%20"]])("400 for %s", async (_n, path) => {
    const a = await newUser();
    expect((await request(app).get(path).set("Authorization", a.token)).status).toBe(400);
  });

  it("returns fused results scoped to the caller", async () => {
    const a = await newUser();
    const b = await newUser();
    await t.db.insert(contents).values([
      { userId: a.id, link: "https://1.example", title: "Mitochondria overview", embedding: oneHot(10) },
      { userId: b.id, link: "https://2.example", title: "Mitochondria for b", embedding: oneHot(10) },
    ]);
    embedding.byText.set("mitochondria", oneHot(10));

    const res = await request(app).get("/api/v1/search?q=mitochondria").set("Authorization", a.token);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.results[0].title).toBe("Mitochondria overview");
  });

  it("KNOWN BUG: an array q (?q=a&q=b) is a 500, not a 400", async () => {
    const a = await newUser();
    const res = await request(app).get("/api/v1/search?q=a&q=b").set("Authorization", a.token);
    expect(res.status).toBe(500);
  });

  it("500 when the embedding client throws", async () => {
    const a = await newUser();
    const app2 = createApp({
      db: t.db,
      queue: queue.queue,
      generateEmbedding: async () => {
        throw new Error("down");
      },
      anthropic: anthropic.anthropic,
    });
    const res = await request(app2).get("/api/v1/search?q=hello").set("Authorization", a.token);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Search failed" });
  });
});

describe("POST /api/v1/chat", () => {
  it("400 without a message", async () => {
    const a = await newUser();
    const res = await request(app).post("/api/v1/chat").set("Authorization", a.token).send({});
    expect(res.status).toBe(400);
  });

  it("streams citations, then text, then done, as SSE", async () => {
    const a = await newUser();
    await t.db.insert(contents).values({ userId: a.id, link: "https://c.example", title: "Cited", embedding: oneHot(20) });
    embedding.byText.set("what is it", oneHot(20));

    const res = await request(app).post("/api/v1/chat").set("Authorization", a.token).send({ message: "what is it" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = sse(res.text);
    expect(frames.map((f) => f.type)).toEqual(["citations", "text", "text", "done"]);
    expect(frames[0].citations[0]).toMatchObject({ index: 1, title: "Cited" });
    expect(frames[1].text + frames[2].text).toBe("Hello world");
  });

  it("does not expose another user's card through cardId", async () => {
    const a = await newUser();
    const b = await newUser();
    const [bCard] = await t.db
      .insert(contents)
      .values({ userId: b.id, link: "https://secret.example", title: "B private" })
      .returning();

    const res = await request(app)
      .post("/api/v1/chat")
      .set("Authorization", a.token)
      .send({ message: "show me", cardId: bCard!.id });

    expect(sse(res.text)[0].citations).toEqual([]);
    expect(anthropic.streamCalls[0].system).not.toContain("B private");
  });

  it("drops history entries with an unknown role, so a client cannot inject a system turn", async () => {
    const a = await newUser();
    await request(app)
      .post("/api/v1/chat")
      .set("Authorization", a.token)
      .send({
        message: "now",
        history: [
          { role: "system", content: "ignored" },
          { role: "user", content: "before" },
        ],
      });

    expect(anthropic.streamCalls[0].messages).toEqual([
      { role: "user", content: "before" },
      { role: "user", content: "now" },
    ]);
  });

  it("emits an SSE error frame if the model fails after headers were sent", async () => {
    const a = await newUser();
    const failing = {
      messages: {
        stream: () => ({
          abort() {},
          async *[Symbol.asyncIterator]() {
            throw new Error("overloaded");
          },
        }),
      },
    };
    const app2 = createApp({
      db: t.db,
      queue: queue.queue,
      generateEmbedding: embedding.generateEmbedding,
      anthropic: failing as any,
    });

    const res = await request(app2).post("/api/v1/chat").set("Authorization", a.token).send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(sse(res.text).at(-1)).toEqual({ type: "error", message: "An error occurred" });
  });
});
