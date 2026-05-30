import express from "express";
import jwt from "jsonwebtoken";
import argon2 from "argon2";
import cors from "cors";
import { nanoid } from "nanoid";
import { eq, or, and, ilike, sql, desc, gt } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm";
import { authMiddleware } from "./middleware/middleware";

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

app.use(cors({
     origin: [
       "http://localhost:5173",
       process.env.FRONTEND_URL || "",
     ].filter(Boolean),
   }));

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
      userId: user.id,      
    });
  } catch (err: any) {
    
    
    if (err.code === "23505") {
      return res.status(409).json({ message: "Email or username already taken" });
    }
    console.error(err);
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/v1/signin", async (req, res) => {
  try {
    const { username, email, password } = req.body ?? {};

    
    
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

app.post("/api/v1/content", authMiddleware, async (req, res) => {
  try {
    const { link, title } = req.body;

    if (!link) {
      return res.status(400).json({ message: "Link is required" });
    }

    
    const detection = detectLinkType(link);

    
    
    
    
    const metadata = await fetchMetadata(link, detection.type);

    
    const [content] = await db
      .insert(contents)
      .values({
        link,
        
        title: title || metadata.ogTitle,
        type: detection.type,
        userId: req.userId!,
        
        ogTitle: metadata.ogTitle,
        ogDescription: metadata.ogDescription,
        ogImage: metadata.ogImage,
        ogSiteName: metadata.ogSiteName,
        favicon: metadata.favicon,
        
        embedUrl: detection.embedUrl,
        
        extractedText: metadata.extractedText,
        
        
        processingStatus: "pending",
      })
      .returning();

    
    
    
    
    
    
    
    
    await contentQueue.add(
      "process-content",       
      { contentId: content.id },
      {
        
        
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

app.get("/api/v1/content", authMiddleware, async (req, res) => {
  try {
    const result = await db
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
      .where(eq(contents.userId, req.userId!))
      .orderBy(contents.createdAt);

    res.json({ content: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch content" });
  }
});

app.delete("/api/v1/content", authMiddleware, async (req, res) => {
  try {
    const contentId = req.body.contentId;

    
    
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

app.post("/api/v1/brain/share", authMiddleware, async (req, res) => {
  const share = req.body.share;

  
  if (!share) {
    await db
      .delete(shareLinks)
      .where(eq(shareLinks.userId, req.userId!));   
    return res.json({ message: "Removed shareable link" });
  }

  try {
    
    const [existingLink] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.userId, req.userId!))
      .limit(1);

    if (existingLink) {
      return res.json({ hash: existingLink.hash });
    }

    
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

app.get("/api/v1/search", authMiddleware, async (req, res) => {
  try {
    const query = (req.query.q as string)?.trim();
    if (!query) {
      return res.status(400).json({ message: "Query is required" });
    }

    const userId = req.userId!;

    
    
    const queryEmbedding = await generateEmbedding(query);

    let vectorResults: any[] = [];
    if (queryEmbedding) {
      
      
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

app.post("/api/v1/chat", authMiddleware, async (req, res) => {
  try {
    const { message, history, cardId } = req.body;

    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    const userId = req.userId!;
    let relevantContent: any[] = [];

    
    
    
    
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

      
      const existingIds = new Set(relevantContent.map((c) => c.id));
      for (const vr of vectorResults) {
        if (!existingIds.has(vr.id)) {
          relevantContent.push(vr);
        }
      }
    }

    
    
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

    
    const contextBlock = relevantContent.length > 0
      ? relevantContent
          .map((c, i) => {
            const text = c.extractedText?.slice(0, 6000) ?? c.summary ?? c.ogDescription ?? "";
            return `[${i + 1}] "${c.title ?? c.ogTitle ?? c.link}" (${c.type})\nURL: ${c.link}\n${text}`;
          })
          .join("\n\n---\n\n")
      : "No saved content found.";

    
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    if (Array.isArray(history)) {
      for (const h of history) {
        if (h.role === "user" || h.role === "assistant") {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    messages.push({ role: "user", content: message });

    
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port: ${PORT}`);
});
