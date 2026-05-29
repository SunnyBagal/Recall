import { pgTable, pgEnum, uuid, text, timestamp, vector } from "drizzle-orm/pg-core";

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
});

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
