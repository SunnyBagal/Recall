-- Standalone migration: btree on contents.user_id.
--
-- Same mechanism as 0001 and 0002: apply directly, then db/schema.ts keeps it in
-- sync.
--
--   psql "$DATABASE_URL" -f drizzle/0003_contents_user_id_index.sql
--
-- Serves the exact vector scan for small users and the bounded row count that
-- routes between it and HNSW (services/searchService.ts). Without it both fall back
-- to reading the whole table.
--
-- CONCURRENTLY avoids blocking writes during the build; it cannot run in a
-- transaction block (psql -f autocommit is fine).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contents_user_id
  ON contents (user_id);
