// Seed synthetic embeddings + realistic text into the local Postgres.
//
//   cd recall-backend
//   bun run bench/seed-vectors.ts                 # 10k rows (default)
//   bun run bench/seed-vectors.ts --scale=50000   # custom scale
//   bun run bench/seed-vectors.ts --wipe          # remove synthetic rows only
//
// Idempotent: every run first deletes existing synthetic rows (single
// tag-scoped DELETE on SYNTHETIC_TAG), so re-running never double-counts.
// All rows are owned by the dedicated BENCH_USER and carry random UNIT vectors
// of dimension 1536 plus article-length text (so the ILIKE arm has real work).

import argon2 from "argon2";
import pg from "pg";
import {
  BENCH_USER,
  DIM,
  SYNTHETIC_TAG,
  TARGET_DEFAULT,
  makeContentRow,
  randomUnitVector,
  requireSafeDatabaseUrl,
  vectorLiteral,
} from "./shared";

const { Pool } = pg;

function parseArgs() {
  const args = process.argv.slice(2);
  const val = (name: string) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split("=")[1] : undefined;
  };
  return {
    scale: parseInt(val("scale") ?? process.env.BENCH_SCALE ?? String(TARGET_DEFAULT), 10),
    batch: parseInt(val("batch") ?? "250", 10),
    wipe: args.includes("--wipe"),
  };
}

async function main() {
  const { scale, batch, wipe } = parseArgs();
  // Safety gate BEFORE any connection/mutation: never seed/wipe a remote DB.
  const { url, host } = requireSafeDatabaseUrl();
  console.log(`seed-vectors: env recall-backend/.env (Bun auto-load) | DB host ${host} | mode ${wipe ? "wipe" : `seed ${scale}`}`);
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query(`create extension if not exists vector`);

    // Upsert the dedicated bench user. argon2id params match the /signup route
    // so the benchmark's /signin succeeds against this hash.
    const hash = await argon2.hash(BENCH_USER.password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const ures = await client.query(
      `insert into users (username, email, password) values ($1, $2, $3)
       on conflict (email) do update set password = excluded.password
       returning id`,
      [BENCH_USER.username, BENCH_USER.email, hash],
    );
    const userId: string = ures.rows[0].id;

    // Idempotent wipe of prior synthetic rows (one tag-scoped delete).
    const del = await client.query(`delete from contents where tags @> ARRAY[$1]::text[]`, [
      SYNTHETIC_TAG,
    ]);
    console.log(`Wiped ${del.rowCount} existing synthetic rows (tag "${SYNTHETIC_TAG}").`);

    if (wipe) {
      const c = await client.query(`select count(*)::int as n from contents`);
      console.log(`--wipe done. contents count(*) = ${c.rows[0].n}`);
      return;
    }

    const COLS = 11;
    let inserted = 0;
    const t0 = Date.now();
    for (let start = 0; start < scale; start += batch) {
      const n = Math.min(batch, scale - start);
      const rowsSql: string[] = [];
      const params: any[] = [];
      for (let j = 0; j < n; j++) {
        const r = makeContentRow(start + j);
        const b = j * COLS;
        rowsSql.push(
          `($${b + 1},$${b + 2},$${b + 3}::content_type,$${b + 4},$${b + 5},$${b + 6},` +
            `$${b + 7},$${b + 8},$${b + 9}::text[],$${b + 10}::processing_status,$${b + 11}::vector)`,
        );
        params.push(
          r.link,
          r.title,
          "link",
          userId,
          r.ogTitle,
          r.ogDescription,
          r.extractedText,
          r.summary,
          [SYNTHETIC_TAG],
          "done",
          vectorLiteral(randomUnitVector(DIM)),
        );
      }
      await client.query(
        `insert into contents
           (link, title, type, user_id, og_title, og_description,
            extracted_text, summary, tags, processing_status, embedding)
         values ${rowsSql.join(",")}`,
        params,
      );
      inserted += n;
      process.stdout.write(`\rInserted ${inserted}/${scale}`);
    }
    process.stdout.write("\n");
    console.log(`Seeded ${inserted} synthetic rows in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

    // Help the planner pick the HNSW index once rows exist.
    await client.query(`analyze contents`);

    const total = await client.query(`select count(*)::int as n from contents`);
    const synth = await client.query(
      `select count(*)::int as n from contents where tags @> ARRAY[$1]::text[]`,
      [SYNTHETIC_TAG],
    );
    console.log(
      `contents count(*) = ${total.rows[0].n}  (synthetic: ${synth.rows[0].n}, all with embeddings)`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
