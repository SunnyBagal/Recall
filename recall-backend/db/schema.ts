import { pgTable, pgEnum, uuid, text, timestamp, vector, index, customType } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Drizzle has no built-in tsvector type; the column is only ever written by
// Postgres itself (GENERATED ALWAYS ... STORED) and read via SQL operators.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
  // FTS document for the lexical search arm (drizzle/0002_fts_search_vector.sql).
  // Weighted by field importance: title=A, og_title=B, summary=C,
  // og_description=D. coalesce keeps the expression null-safe; the explicit
  // 'english' config keeps it IMMUTABLE (required for a generated column).
  searchVector:     tsvector("search_vector").generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(og_title, '')), 'B') || setweight(to_tsvector('english', coalesce(summary, '')), 'C') || setweight(to_tsvector('english', coalesce(og_description, '')), 'D')`,
  ),
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
  // GIN index for the FTS lexical arm (search_vector @@ websearch_to_tsquery).
  index("idx_contents_search_vector_gin").using("gin", t.searchVector),
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
