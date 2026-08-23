// Seed a DEDICATED bench database (never touches dev data).
//
//   bun run bench/rigor/seed.ts --scale=10000
//
// Creates database recall_bench_<scale> (dropped and rebuilt each run), with
// the app's schema subset: users + contents incl. the 1536-dim vector column,
// and the HNSW index with the SAME parameters as db/schema.ts
// (m=16, ef_construction=64, vector_cosine_ops). All rows are deterministic
// (fixed-seed PRNG — see gen.ts), owned by one bench user.

import pg from "pg";
import { DIM, SYNTHETIC_TAG, requireSafeDatabaseUrl, vectorLiteral } from "../shared";
import { benchDbName, benchDbUrl, makeRow, rowEmbedding, textQueries } from "./gen";

const { Client } = pg;

// Must match db/schema.ts exactly — the whole point is benching prod config.
const HNSW = { m: 16, ef_construction: 64 };

function parseScale(): number {
  const a = process.argv.slice(2).find((x) => x.startsWith("--scale="));
  const n = parseInt(a?.split("=")[1] ?? "10000", 10);
  if (!Number.isFinite(n) || n < 1) throw new Error(`bad --scale`);
  return n;
}

async function main() {
  const scale = parseScale();
  const { url: baseUrl, host } = requireSafeDatabaseUrl();
  const dbName = benchDbName(scale);
  console.log(`rigor seed: host ${host} | bench db ${dbName} | scale ${scale}`);

  // 1. (Re)create the bench DB from the maintenance connection (the base URL's
  //    own database — only CREATE/DROP DATABASE statements run there).
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  // 2. Schema in the bench DB.
  const c = new Client({ connectionString: benchDbUrl(baseUrl, scale) });
  await c.connect();
  await c.query(`create extension if not exists vector`);
  await c.query(`
    create type content_type as enum
      ('youtube','twitter','reddit','github','instagram','article','link');
    create type processing_status as enum ('pending','processing','done','failed');
    create table users (
      id uuid primary key default gen_random_uuid(),
      username text not null,
      email text not null unique,
      password text not null,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
    create table contents (
      id uuid primary key default gen_random_uuid(),
      link text not null,
      title text,
      type content_type not null default 'link',
      user_id uuid not null references users(id) on delete cascade,
      og_title text,
      og_description text,
      og_image text,
      og_site_name text,
      favicon text,
      embed_url text,
      extracted_text text,
      summary text,
      tags text[] default '{}',
      processing_status processing_status not null default 'pending',
      embedding vector(${DIM}),
      search_vector tsvector generated always as (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(og_title, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(og_description, '')), 'D')
      ) stored,
      created_at timestamp not null default now(),
      updated_at timestamp not null default now()
    );
  `);
  const u = await c.query(
    `insert into users (username, email, password)
     values ('bench_user', 'bench-user@bench.local', 'not-a-real-hash') returning id`,
  );
  const userId: string = u.rows[0].id;

  // 3. Deterministic rows, batched inserts.
  const phrases = textQueries();
  const COLS = 11;
  const BATCH = 100;
  const t0 = Date.now();
  for (let start = 0; start < scale; start += BATCH) {
    const n = Math.min(BATCH, scale - start);
    const rowsSql: string[] = [];
    const params: any[] = [];
    for (let j = 0; j < n; j++) {
      const i = start + j;
      const r = makeRow(i, phrases);
      const b = j * COLS;
      rowsSql.push(
        `($${b + 1},$${b + 2},'link',$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},` +
          `$${b + 8}::text[],'done',$${b + 9}::vector,$${b + 10},$${b + 11})`,
      );
      params.push(
        r.link, r.title, userId, r.ogTitle, r.ogDescription, r.extractedText,
        r.summary, [SYNTHETIC_TAG], vectorLiteral(rowEmbedding(i)),
        // deterministic timestamps too, so dumps are comparable
        new Date(Date.UTC(2026, 0, 1) + i * 1000), new Date(Date.UTC(2026, 0, 1) + i * 1000),
      );
    }
    await c.query(
      `insert into contents
         (link, title, type, user_id, og_title, og_description, extracted_text,
          summary, tags, processing_status, embedding, created_at, updated_at)
       values ${rowsSql.join(",")}`,
      params,
    );
    process.stdout.write(`\rinserted ${Math.min(start + n, scale)}/${scale}`);
  }
  console.log(`\nrows inserted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 4. HNSW index with production params, built after the load (faster), with
  //    enough maintenance memory that the graph build doesn't spill.
  // Serial build: parallel workers allocate the graph in dynamic shared memory,
  // which overflows the Docker container's small /dev/shm at 1GB. A serial
  // build keeps it in backend-local memory.
  await c.query(`set maintenance_work_mem = '1GB'`);
  await c.query(`set max_parallel_maintenance_workers = 0`);
  const ti = Date.now();
  await c.query(
    `create index idx_contents_embedding_hnsw on contents
       using hnsw (embedding vector_cosine_ops)
       with (m = ${HNSW.m}, ef_construction = ${HNSW.ef_construction})`,
  );
  console.log(`hnsw index built in ${((Date.now() - ti) / 1000).toFixed(1)}s (m=${HNSW.m}, ef_construction=${HNSW.ef_construction})`);

  // GIN index for the FTS arm — same definition as drizzle/0002.
  const tg = Date.now();
  await c.query(
    `create index idx_contents_search_vector_gin on contents using gin (search_vector)`,
  );
  console.log(`gin index built in ${((Date.now() - tg) / 1000).toFixed(1)}s`);
  await c.query(`analyze contents`);

  const n = await c.query(`select count(*)::int as n from contents where embedding is not null`);
  console.log(`done: ${dbName} contents=${n.rows[0].n} (all with embeddings), bench user ${userId}`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
