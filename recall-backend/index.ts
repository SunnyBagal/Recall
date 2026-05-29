import express from "express";
import jwt from "jsonwebtoken";
import argon2 from "argon2";
import cors from "cors";
import { nanoid } from "nanoid";
import { eq, or, and, ilike, sql, desc, gt } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { authMiddleware } from "./middleware/middleware";

// ── NEW: Drizzle imports (replaces Mongoose model imports) ──
// Before: import { ContentModel, LinkModel, UserModel } from './model/database';
// After:  import the db connection + schema tables
import { db } from "./config/db";
import { users, contents, shareLinks } from "./db/schema";
import { detectLinkType } from "./services/linkDetector";
import { fetchMetadata } from "./services/metadataFetcher";
import { contentQueue } from "./config/queue";
import { generateEmbedding } from "./services/embeddings";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

const JWT_SECRET = process.env.JWT_SECRET!;
const app = express();
app.use(express.json());
app.use(cors());


// ─── SIGNUP ─────────────────────────────────────────────────────
// Changes from Mongoose version:
//   - UserModel.create({...})  →  db.insert(users).values({...}).returning()
//   - err.code === 11000       →  err.code === "23505" (PostgreSQL unique violation)
//   - user._id                 →  user.id (UUID, not ObjectId)

app.post("/api/v1/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body ?? {};

    if (!username || !email || !password) {
      return res.status(400).json({
        message: "Username, email and password are required",
      });
    }

    const hashedPassword = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    // OLD: const user = await UserModel.create({ username, email, password: hashedPassword });
    // NEW: db.insert().values().returning() — the .returning() is crucial,
    //      without it PostgreSQL doesn't give you back the created row.
    const [user] = await db
      .insert(users)
      .values({
        username,
        email,
        password: hashedPassword,
      })
      .returning();
      
    
    return res.status(201).json({
      message: "User created",
      userId: user.id,      // was user._id in Mongoose
    });
  } catch (err: any) {
    // PostgreSQL unique constraint violation code is "23505" (string, not number)
    // Mongoose/MongoDB uses numeric 11000
    if (err.code === "23505") {
      return res.status(409).json({ message: "Email or username already taken" });
    }
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});


// ─── SIGNIN ─────────────────────────────────────────────────────
// Changes from Mongoose version:
//   - UserModel.findOne({ $or: [...] })  →  db.select().where(or(eq(), eq()))
//   - user._id.toString()                →  user.id (already a string UUID)

app.post("/api/v1/signin", async (req, res) => {
  try {
    const { username, email, password } = req.body ?? {};

    // OLD: UserModel.findOne({ $or: [{ username }, { email }] })
    // NEW: Build OR conditions dynamically, same logic as before
    const conditions = [];
    if (username) conditions.push(eq(users.username, username));
    if (email) conditions.push(eq(users.email, email));

    if (conditions.length === 0) {
      return res.status(400).json({ message: "Email or username required" });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(or(...conditions))
      .limit(1);

    if (!user) {
      return res.status(403).json({
        message: "Incorrect Credentials!",
      });
    }

    const isValidPassword = await argon2.verify(user.password, password);
    if (!isValidPassword) {
      return res.status(401).json({
        message: "Invalid credentials",
      });
    }

    // user.id is already a string (UUID), no .toString() needed
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "24h",
    });

    res.json({ token });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Internal server error",
    });
  }
});


// ─── CREATE CONTENT ─────────────────────────────────────────────
// Day 1 upgrade: The client now only needs to send { link }.
// The backend auto-detects the content type and fetches metadata.
//
// Flow:
// 1. Client sends { link } (optionally { link, title })
// 2. linkDetector classifies the URL → youtube, twitter, article, etc.
// 3. metadataFetcher grabs OG tags + article text (1-3 sec HTTP call)
// 4. Everything is stored in one INSERT
// 5. Response sent back immediately → card appears on frontend
// 6. (Day 2) Heavy processing (summary, embeddings) queued to BullMQ

app.post("/api/v1/content", authMiddleware, async (req, res) => {
  try {
    const { link, title } = req.body;

    if (!link) {
      return res.status(400).json({ message: "Link is required" });
    }

    // Step 1: Detect what kind of link this is (pure regex, instant)
    const detection = detectLinkType(link);

    // Step 2: Fetch OpenGraph metadata from the page (1-3 sec network call)
    // This is the only "slow" part of content creation, but it's fast enough
    // to do synchronously. The really slow stuff (LLM summary, embeddings)
    // will be async via BullMQ on Day 2.
    const metadata = await fetchMetadata(link, detection.type);

    // Step 3: Insert everything into the database
    const [content] = await db
      .insert(contents)
      .values({
        link,
        // Use client-provided title if given, otherwise use OG title
        title: title || metadata.ogTitle,
        type: detection.type,
        userId: req.userId!,
        // Metadata from the page
        ogTitle: metadata.ogTitle,
        ogDescription: metadata.ogDescription,
        ogImage: metadata.ogImage,
        ogSiteName: metadata.ogSiteName,
        favicon: metadata.favicon,
        // Embed URL for iframe rendering (YouTube, Reddit, Instagram)
        embedUrl: detection.embedUrl,
        // Article text (if extracted by Readability)
        extractedText: metadata.extractedText,
        // Processing status starts as "pending" — the BullMQ worker will
        // pick this up for text extraction, summary generation, and tagging.
        processingStatus: "pending",
      })
      .returning();

    // ── Queue background processing (Day 2) ──
    // The worker (worker.ts) will:
    // 1. Extract text (YouTube transcript, GitHub README, etc.)
    // 2. Call Claude API for summary + auto-tags
    // 3. (Day 3) Generate vector embedding for semantic search
    // This is fire-and-forget — we don't await it.
    // If Redis is down, the content is still saved; it just won't
    // get a summary until the job is retried.
    await contentQueue.add(
      "process-content",       // job name (for filtering in dashboards)
      { contentId: content.id },
      {
        // Delay 1 second — give the DB transaction time to commit
        // and avoid a race where the worker reads before the row exists
        delay: 1000,
      }
    );

    return res.status(201).json({
      message: "Content created",
      contentId: content.id,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Failed to create content" });
  }
});


// ─── GET ALL CONTENT ────────────────────────────────────────────
// Changes from Mongoose version:
//   - ContentModel.find({ userId }).populate("userId", "username")
//   →  db.select().from(contents).innerJoin(users, ...).where(...)
//
//   .populate() in Mongoose does a second query behind the scenes.
//   In Drizzle, we use an explicit JOIN — same result, but you see exactly what SQL runs.

app.get("/api/v1/content", authMiddleware, async (req, res) => {
  try {
    const result = await db
      .select({
        // Pick exactly which columns to return.
        // In Mongoose, .populate("userId", "username") returned the full content doc
        // with userId replaced by { _id, username }. Here we flatten it.
        id: contents.id,
        title: contents.title,
        link: contents.link,
        type: contents.type,
        tags: contents.tags,
        ogTitle: contents.ogTitle,
        ogDescription: contents.ogDescription,
        ogImage: contents.ogImage,
        ogSiteName: contents.ogSiteName,
        favicon: contents.favicon,
        embedUrl: contents.embedUrl,
        summary: contents.summary,
        processingStatus: contents.processingStatus,
        createdAt: contents.createdAt,
        // From the joined users table:
        username: users.username,
      })
      .from(contents)
      .innerJoin(users, eq(contents.userId, users.id))
      .where(eq(contents.userId, req.userId!))
      .orderBy(contents.createdAt);

    res.json({ content: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch content" });
  }
});


// ─── DELETE CONTENT ─────────────────────────────────────────────
// Bug fix: Your Mongoose version used deleteMany with { contentId, userId }
// but ContentModel doesn't have a "contentId" field — it should be _id.
// Fixed here to use the correct content.id field.

app.delete("/api/v1/content", authMiddleware, async (req, res) => {
  try {
    const contentId = req.body.contentId;

    // OLD: await ContentModel.deleteMany({ contentId, userId: req.userId })
    // FIX: match on the content's actual id, AND ensure it belongs to this user
    const deleted = await db
      .delete(contents)
      .where(
        and(
          eq(contents.id, contentId),
          eq(contents.userId, req.userId!)
        )
      )
      .returning({ id: contents.id });

    if (deleted.length === 0) {
      return res.status(404).json({ message: "Content not found" });
    }

    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete content" });
  }
});


// ─── SHARE BRAIN ────────────────────────────────────────────────
// Changes from Mongoose version:
//   - LinkModel.findOne/create/deleteOne  →  db.select/insert/delete on shareLinks
//   - Fixed: the unshare path had a bug (used req.body.userId instead of req.userId)

app.post("/api/v1/brain/share", authMiddleware, async (req, res) => {
  const share = req.body.share;

  // If share is false, user wants to remove their share link
  if (!share) {
    await db
      .delete(shareLinks)
      .where(eq(shareLinks.userId, req.userId!));   // was req.body.userId (bug)
    return res.json({ message: "Removed shareable link" });
  }

  try {
    // Check if user already has a share link
    const [existingLink] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.userId, req.userId!))
      .limit(1);

    if (existingLink) {
      return res.json({ hash: existingLink.hash });
    }

    // Create new share link
    const hash = nanoid(12);
    await db.insert(shareLinks).values({
      userId: req.userId!,
      hash,
    });

    res.json({ hash: "/share/" + hash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create share link" });
  }
});


// ─── GET SHARED BRAIN ───────────────────────────────────────────
// Changes: Same logic, Drizzle syntax instead of Mongoose

app.get("/api/v1/brain/:shareLink", async (req, res) => {
  const hash = req.params.shareLink;

  const [link] = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.hash, hash))
    .limit(1);

  if (!link) {
    return res.status(404).json({ message: "Invalid share link" });
  }

  const [user] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, link.userId))
    .limit(1);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  const content = await db
    .select()
    .from(contents)
    .where(eq(contents.userId, link.userId))
    .orderBy(contents.createdAt);

  res.json({
    username: user.username,
    content,
  });
});


// ─── SEMANTIC SEARCH (Day 3) ────────────────────────────────────
// User types a natural language query → we embed it → find similar content
// via pgvector cosine distance → fall back to keyword search → merge results.
//
// Interview explanation:
// "Pure vector search misses exact keyword matches (searching 'Redis' might
// not find a link titled 'Redis Caching Guide' if the embeddings diverge).
// Pure keyword search misses semantic matches ('that video about caching'
// won't match 'Redis Performance Tips'). I combined both using reciprocal
// rank fusion — vector results and keyword results each get a score, and
// I merge them to get the best of both worlds."

app.get("/api/v1/search", authMiddleware, async (req, res) => {
  try {
    const query = (req.query.q as string)?.trim();
    if (!query) {
      return res.status(400).json({ message: "Query is required" });
    }

    const userId = req.userId!;

    // ── Vector search ──
    // Generate an embedding for the search query
    const queryEmbedding = await generateEmbedding(query);

    let vectorResults: any[] = [];
    if (queryEmbedding) {
      // cosineDistance returns 0 for identical vectors, 2 for opposite.
      // Similarity = 1 - distance. We want similarity > 0.3 (somewhat related).
      const similarity = sql<number>`1 - (${cosineDistance(contents.embedding, queryEmbedding)})`;

      vectorResults = await db
        .select({
          id: contents.id,
          title: contents.title,
          link: contents.link,
          type: contents.type,
          tags: contents.tags,
          ogTitle: contents.ogTitle,
          ogDescription: contents.ogDescription,
          ogImage: contents.ogImage,
          ogSiteName: contents.ogSiteName,
          favicon: contents.favicon,
          embedUrl: contents.embedUrl,
          summary: contents.summary,
          processingStatus: contents.processingStatus,
          createdAt: contents.createdAt,
          username: users.username,
          similarity,
        })
        .from(contents)
        .innerJoin(users, eq(contents.userId, users.id))
        .where(and(eq(contents.userId, userId), gt(similarity, 0.3)))
        .orderBy(desc(similarity))
        .limit(10);
    }

    // ── Keyword fallback ──
    // Search title, summary, and OG title with case-insensitive LIKE
    const keywordPattern = `%${query}%`;
    const keywordResults = await db
      .select({
        id: contents.id,
        title: contents.title,
        link: contents.link,
        type: contents.type,
        tags: contents.tags,
        ogTitle: contents.ogTitle,
        ogDescription: contents.ogDescription,
        ogImage: contents.ogImage,
        ogSiteName: contents.ogSiteName,
        favicon: contents.favicon,
        embedUrl: contents.embedUrl,
        summary: contents.summary,
        processingStatus: contents.processingStatus,
        createdAt: contents.createdAt,
        username: users.username,
      })
      .from(contents)
      .innerJoin(users, eq(contents.userId, users.id))
      .where(
        and(
          eq(contents.userId, userId),
          or(
            ilike(contents.title, keywordPattern),
            ilike(contents.summary, keywordPattern),
            ilike(contents.ogTitle, keywordPattern),
            ilike(contents.ogDescription, keywordPattern)
          )
        )
      )
      .limit(10);

    // ── Reciprocal Rank Fusion ──
    // Combine vector and keyword results, dedup by ID,
    // score each by 1/(rank + 60) from each list.
    const scores = new Map<string, { score: number; item: any }>();

    vectorResults.forEach((item, idx) => {
      const existing = scores.get(item.id);
      const rrfScore = 1 / (idx + 60);
      scores.set(item.id, {
        score: (existing?.score ?? 0) + rrfScore,
        item,
      });
    });

    keywordResults.forEach((item, idx) => {
      const existing = scores.get(item.id);
      const rrfScore = 1 / (idx + 60);
      scores.set(item.id, {
        score: (existing?.score ?? 0) + rrfScore,
        item: existing?.item ?? item,
      });
    });

    // Sort by combined score, return top 10
    const merged = Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ item }) => item);

    res.json({ results: merged, total: merged.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Search failed" });
  }
});


// ─── RAG CHAT (Day 4-5) ────────────────────────────────────────
// User asks a question → retrieve relevant content via vector search →
// inject as context into Claude → stream the response with citations.
//
// Interview explanation:
// "The RAG pipeline has three stages: retrieval, augmentation, and generation.
// Retrieval uses the same pgvector search as the search feature. Augmentation
// formats the retrieved content as numbered context items. Generation sends
// the augmented prompt to Claude with instructions to cite sources using [1],
// [2] markers. I parse these markers on the frontend to create clickable
// links back to the original saved cards."

app.post("/api/v1/chat", authMiddleware, async (req, res) => {
  try {
    const { message, history, cardId } = req.body;

    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    const userId = req.userId!;
    let relevantContent: any[] = [];

    // ── Strategy 1: If asking about a specific card, look it up directly ──
    // This is the fix for "I don't have access to that video" — when the user
    // clicks the sparkle icon on a card, we get the card's actual content
    // from the DB instead of hoping vector search finds it.
    if (cardId) {
      const [card] = await db
        .select()
        .from(contents)
        .where(and(eq(contents.id, cardId), eq(contents.userId, userId)))
        .limit(1);

      if (card) {
        relevantContent.push(card);
      }
    }

    // ── Strategy 2: Vector search for additional context ──
    const queryEmbedding = await generateEmbedding(message);

    if (queryEmbedding) {
      const similarity = sql<number>`1 - (${cosineDistance(contents.embedding, queryEmbedding)})`;

      const vectorResults = await db
        .select({
          id: contents.id,
          title: contents.title,
          link: contents.link,
          type: contents.type,
          summary: contents.summary,
          extractedText: contents.extractedText,
          ogTitle: contents.ogTitle,
          ogDescription: contents.ogDescription,
        })
        .from(contents)
        .where(and(eq(contents.userId, userId), gt(similarity, 0.25)))
        .orderBy(desc(similarity))
        .limit(5);

      // Merge, dedup by id (the specific card might already be in vector results)
      const existingIds = new Set(relevantContent.map((c) => c.id));
      for (const vr of vectorResults) {
        if (!existingIds.has(vr.id)) {
          relevantContent.push(vr);
        }
      }
    }

    // ── Strategy 3: Fallback if no vector results (embeddings not generated yet) ──
    // Get the user's most recent content as context
    if (relevantContent.length === 0) {
      relevantContent = await db
        .select({
          id: contents.id,
          title: contents.title,
          link: contents.link,
          type: contents.type,
          summary: contents.summary,
          extractedText: contents.extractedText,
          ogTitle: contents.ogTitle,
          ogDescription: contents.ogDescription,
        })
        .from(contents)
        .where(eq(contents.userId, userId))
        .orderBy(desc(contents.createdAt))
        .limit(5);
    }

    // Build the augmented prompt with numbered context
    const contextBlock = relevantContent.length > 0
      ? relevantContent
          .map((c, i) => {
            const text = c.extractedText?.slice(0, 6000) ?? c.summary ?? c.ogDescription ?? "";
            return `[${i + 1}] "${c.title ?? c.ogTitle ?? c.link}" (${c.type})\nURL: ${c.link}\n${text}`;
          })
          .join("\n\n---\n\n")
      : "No saved content found.";

    // Build conversation messages
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h.role === "user" || h.role === "assistant") {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    messages.push({ role: "user", content: message });

    // Stream response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const citations = relevantContent.map((c, i) => ({
      index: i + 1,
      id: c.id,
      title: c.title ?? c.ogTitle ?? c.link,
      link: c.link,
      type: c.type,
    }));
    res.write(`data: ${JSON.stringify({ type: "citations", citations })}\n\n`);

    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: `You are Recall AI, a helpful assistant that answers questions based on the user's saved links and content. You have access to the user's saved content provided below as numbered sources.

RULES:
- Answer based on the provided sources. You DO have access to the content — it is provided below.
- Cite sources using [1], [2], etc. when you reference information from them.
- Give detailed, thorough answers. Extract specific facts, names, numbers, and quotes from the source text.
- When asked to "tell me about" something, provide a comprehensive summary covering all key points from the source material.
- When asked to summarize or compare, reference specific sources with details.
- Never say you don't have access to content or that content is incomplete — work with what's provided.
- Format with markdown for readability when appropriate.

USER'S SAVED CONTENT:
${contextBlock}`,
      messages,
    });

    // Abort the Claude stream if the client disconnects mid-response.
    // Without this, Claude keeps generating (and billing) tokens even
    // after the user closes the tab or navigates away.
    req.on("close", () => stream.abort());

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ type: "text", text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
    res.end();
  } catch (err) {
    console.error(err);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "An error occurred" })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ message: "Chat failed" });
    }
  }
});


// ─── START SERVER ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port: ${PORT}`);
});