// Backfill embeddings for rows that have none.
//
// Rows saved while OPENAI_API_KEY was unset or the account was out of credit
// were marked processing_status='done' with embedding = NULL, which silently
// disables the vector half of hybrid search for them. This re-embeds those
// rows in place. It does NOT re-fetch or re-summarize — use
// scripts/repair-blocked-metadata.ts for that.
//
//   bun run scripts/backfill-embeddings.ts                       # dry run, local
//   bun run scripts/backfill-embeddings.ts --db="$PROD_URL"      # dry run, prod
//   bun run scripts/backfill-embeddings.ts --db="$PROD_URL" --apply
//
// Dry run is the default. It verifies the OpenAI key works before touching
// anything, so a dead key fails loudly instead of quietly writing nothing.

import pg from "pg";
import { generateEmbedding } from "../services/embeddings";

const { Client } = pg;

function parseArgs() {
  const a = process.argv.slice(2);
  return {
    apply: a.includes("--apply"),
    db: a.find((x) => x.startsWith("--db="))?.slice(5) ?? process.env.DATABASE_URL,
    limit: parseInt(a.find((x) => x.startsWith("--limit="))?.slice(8) ?? "500", 10),
  };
}

interface Row {
  id: string;
  link: string;
  type: string;
  title: string | null;
  og_title: string | null;
  summary: string | null;
  extracted_text: string | null;
}

async function main() {
  const { apply, db, limit } = parseArgs();
  if (!db) {
    console.error("No database URL. Pass --db=<url> or set DATABASE_URL.");
    process.exit(1);
  }

  console.log(`backfill-embeddings: host ${new URL(db).hostname} | mode ${apply ? "APPLY (writes)" : "dry run"}`);

  // Fail fast on a dead key/quota rather than looping through every row.
  const probe = await generateEmbedding("connectivity probe");
  if (!probe) {
    console.error(
      "\nOpenAI embedding call failed — nothing was written.\n" +
      "Check that OPENAI_API_KEY is set and the account/project it belongs to has credit\n" +
      "(a 429 with code credit_balance_exhausted means the balance is still zero, and note\n" +
      "that credits are per-organization/project, so a top-up on a different org won't apply).",
    );
    process.exit(1);
  }
  console.log(`OpenAI reachable — probe returned ${probe.length} dims.\n`);

  const c = new Client({ connectionString: db });
  await c.connect();

  const { rows } = await c.query<Row>(
    `select id, link, type, title, og_title, summary, extracted_text
       from contents
      where embedding is null
      order by created_at desc
      limit $1`,
    [limit],
  );

  if (rows.length === 0) {
    console.log("No rows missing embeddings.");
    await c.end();
    return;
  }

  console.log(`${rows.length} row(s) missing embeddings:`);
  for (const r of rows) {
    console.log(`  ${(r.og_title ?? r.title ?? r.link).slice(0, 64)}`);
  }

  if (!apply) {
    console.log(`\nDry run — no changes written. Re-run with --apply to backfill.`);
    await c.end();
    return;
  }

  console.log(`\nEmbedding...\n`);
  let done = 0, skipped = 0, failed = 0;

  for (const r of rows) {
    // Same input composition the worker uses, so backfilled vectors are
    // directly comparable to ones written by the normal pipeline.
    const input = [
      r.title ?? r.og_title ?? "",
      r.summary ?? "",
      (r.extracted_text ?? "").slice(0, 2000),
    ].join("\n\n").trim();

    if (input.length < 10) {
      console.log(`  - skipped (no text): ${r.link.slice(0, 60)}`);
      skipped++;
      continue;
    }

    try {
      const embedding = await generateEmbedding(input);
      if (!embedding) {
        console.log(`  x failed (no embedding returned): ${r.link.slice(0, 55)}`);
        failed++;
        continue;
      }
      await c.query(
        `update contents set embedding = $2::vector, updated_at = now() where id = $1`,
        [r.id, `[${embedding.join(",")}]`],
      );
      console.log(`  + ${(r.og_title ?? r.link).slice(0, 58)}`);
      done++;
    } catch (err) {
      console.error(`  x failed: ${r.link.slice(0, 55)} — ${(err as Error).message}`);
      failed++;
    }
  }

  const { rows: after } = await c.query(
    `select count(*)::int as total, count(embedding)::int as with_emb from contents`,
  );
  console.log(`\nDone. embedded ${done} | skipped ${skipped} | failed ${failed}`);
  console.log(`contents: ${after[0].with_emb}/${after[0].total} rows now have embeddings.`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
