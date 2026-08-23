-- Standalone migration: real Postgres full-text search for the lexical arm.
--
-- Same mechanism as 0001 (this project uses `drizzle-kit push` with no
-- migration journal): apply directly, then db/schema.ts keeps it in sync.
--
--   psql "$DATABASE_URL" -f drizzle/0002_fts_search_vector.sql
--
-- Adds a GENERATED ALWAYS ... STORED tsvector over the four columns the old
-- ILIKE arm searched (services/searchService.ts), weighted by field
-- importance: title=A, og_title=B, summary=C, og_description=D. All four
-- columns are nullable in production — coalesce makes the expression
-- null-safe. to_tsvector/setweight with an EXPLICIT config are IMMUTABLE,
-- which a generated column requires.
--
-- NOTE: ADD COLUMN ... GENERATED STORED rewrites the table (computes the
-- vector for every existing row) and takes an exclusive lock for the rewrite.
-- Fine at this table's size; run it in a quiet window on production.
--
-- CONCURRENTLY avoids blocking writes during the GIN build; it cannot run in
-- a transaction block (psql -f autocommit is fine, matching 0001).

ALTER TABLE contents
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(og_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(og_description, '')), 'D')
  ) STORED;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contents_search_vector_gin
  ON contents USING gin (search_vector);
