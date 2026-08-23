import { pgTable, pgEnum, uuid, text, timestamp, vector, index } from "drizzle-orm/pg-core";

export const contentTypeEnum = pgEnum("content_type", [
  "youtube",
  "twitter",
  "reddit",
  "github",
  "instagram",
  "article",
  "link",
]);

export const processingStatusEnum = pgEnum("processing_status", [
  "pending",
  "processing",
  "done",
  "failed",
]);

export const users = pgTable("users", {
  id:        uuid("id").primaryKey().defaultRandom(),
  username:  text("username").notNull(),
  email:     text("email").notNull().unique(),
  password:  text("password").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const contents = pgTable("contents", {
  id:               uuid("id").primaryKey().defaultRandom(),
  link:             text("link").notNull(),
  title:            text("title"),
  type:             contentTypeEnum("type").notNull().default("link"),
  userId:           uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ogTitle:          text("og_title"),
  ogDescription:    text("og_description"),
  ogImage:          text("og_image"),
  ogSiteName:       text("og_site_name"),
  favicon:          text("favicon"),
  embedUrl:         text("embed_url"),
  extractedText:    text("extracted_text"),
  summary:          text("summary"),
  tags:             text("tags").array().default([]),
  processingStatus: processingStatusEnum("processing_status").notNull().default("pending"),
  embedding:        vector("embedding", { dimensions: 1536 }),
  createdAt:        timestamp("created_at").defaultNow().notNull(),
  updatedAt:        timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // Approximate-NN (HNSW) index for cosine similarity over the 1536-dim embedding.
  // Opclass MUST be `vector_cosine_ops` to match the `<=>` operator emitted by
  // drizzle's cosineDistance() in the search query — an opclass mismatch means
  // the planner silently ignores the index and falls back to a sequential scan.
  // Default HNSW build params: m = 16, ef_construction = 64.
  // NOTE: HNSW is APPROXIMATE. Query-time recall is tuned via `SET hnsw.ef_search`
  // (pgvector default = 40); not changed here.
  // NOTE: the index is only usable when the query does `ORDER BY embedding <=> $vec`
  // (raw distance, ascending) — see services/searchService.ts.
  index("idx_contents_embedding_hnsw")
    .using("hnsw", t.embedding.op("vector_cosine_ops"))
    .with({ m: 16, ef_construction: 64 }),
]);

export const shareLinks = pgTable("share_links", {
  id:     uuid("id").primaryKey().defaultRandom(),
  hash:   text("hash").notNull().unique(),
  userId: uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
});

import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Content = InferSelectModel<typeof contents>;
export type NewContent = InferInsertModel<typeof contents>;

export type ShareLink = InferSelectModel<typeof shareLinks>;
export type NewShareLink = InferInsertModel<typeof shareLinks>;
