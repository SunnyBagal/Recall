-- Standalone migration: add the HNSW index on contents.embedding.
--
-- This project is managed with `drizzle-kit push` and has NO migration
-- baseline/journal (there is no drizzle/meta snapshot). Running
-- `drizzle-kit generate` now would emit a full-schema baseline (CREATE TABLE
-- for every table), which would fail against the already-provisioned DB. So to
-- add ONLY this index to the existing database, apply this file directly:
--
--   psql "$DATABASE_URL" -f drizzle/0001_hnsw_index.sql
--
-- The same index is also declared in db/schema.ts, so `drizzle-kit push` keeps
-- it in sync going forward.
--
-- Opclass `vector_cosine_ops` matches the `<=>` operator emitted by drizzle
-- cosineDistance() in the search query (services/searchService.ts). A mismatch
-- would make the planner silently ignore the index (Seq Scan).
--
-- Default HNSW build params: m = 16, ef_construction = 64.
-- HNSW is approximate; query-time recall is tuned via `SET hnsw.ef_search`
-- (pgvector default = 40) — not changed here.
--
-- CONCURRENTLY avoids locking writes during the build; it cannot run inside a
-- transaction block (psql -f runs each statement in autocommit, which is fine).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contents_embedding_hnsw
  ON contents USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
