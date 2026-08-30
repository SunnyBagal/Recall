// One-shot repair for rows poisoned by the pre-05d5736 metadata fetcher.
//
// Before that fix, fetchMetadata() never checked response.ok, so bot-protection
// pages were parsed as if they were the article: the wall's <title> ("Just a
// moment...", "Attention Required! | Cloudflare") was stored as og_title, and
// its body text was summarized, tagged, and embedded — polluting search.
//
// This script finds those rows, re-fetches them with the fixed fetcher, and
// regenerates summary/tags/embedding inline (no Redis/BullMQ needed, so it can
// be pointed at a remote database from a laptop).
//
//   bun run scripts/repair-blocked-metadata.ts                  # dry run, local DB
//   bun run scripts/repair-blocked-metadata.ts --db="$PROD_URL" # dry run, prod
//   bun run scripts/repair-blocked-metadata.ts --db="$PROD_URL" --apply
//
// Dry run is the default and prints exactly what would change. Nothing is
// written without --apply.

import pg from "pg";
import { CHALLENGE_TITLE, fetchMetadata } from "../services/metadataFetcher";
import { detectLinkType } from "../services/linkDetector";
import { extractText } from "../services/textExtractor";
import { generateSummaryAndTags } from "../services/aiProcessor";
import { generateEmbedding } from "../services/embeddings";

const { Client } = pg;

function parseArgs() {
  const a = process.argv.slice(2);
  return {
    apply: a.includes("--apply"),
    db: a.find((x) => x.startsWith("--db="))?.slice(5) ?? process.env.DATABASE_URL,
    limit: parseInt(a.find((x) => x.startsWith("--limit="))?.slice(8) ?? "100", 10),
  };
}

interface Row {
  id: string;
  link: string;
  type: string;
  og_title: string | null;
  summary: string | null;
  text_len: number;
}

async function main() {
  const { apply, db, limit } = parseArgs();
  if (!db) {
    console.error("No database URL. Pass --db=<url> or set DATABASE_URL.");
    process.exit(1);
  }

  const host = new URL(db).hostname;
  console.log(`repair-blocked-metadata: db host ${host} | mode ${apply ? "APPLY (writes)" : "dry run"}`);

  const c = new Client({ connectionString: db });
  await c.connect();

  // Candidates: the stored title looks like a bot wall. Kept deliberately
  // narrow — a title-pattern match is unambiguous, whereas "row has no
  // extracted text" also matches legitimately thin pages.
  const { rows } = await c.query<Row>(
    `select id, link, type, og_title, summary,
            coalesce(length(extracted_text), 0) as text_len
       from contents
      where og_title ~* $1
      order by created_at desc
      limit $2`,
    [CHALLENGE_TITLE.source, limit],
  );

  if (rows.length === 0) {
    console.log("No poisoned rows found — nothing to repair.");
    await c.end();
    return;
  }

  console.log(`\nFound ${rows.length} row(s) with a bot-wall title:\n`);
  for (const r of rows) {
    console.log(`  ${r.link.slice(0, 70)}`);
    console.log(`    stored title: ${JSON.stringify(r.og_title)} | text ${r.text_len} chars`);
  }

  if (!apply) {
    console.log(`\nDry run — no changes written. Re-run with --apply to repair.`);
    await c.end();
    return;
  }

  console.log(`\nRepairing...\n`);
  let fixed = 0, stillBlocked = 0, failed = 0;

  for (const r of rows) {
    try {
      const detection = detectLinkType(r.link);
      const meta = await fetchMetadata(r.link, detection.type);

      if (meta.blocked) {
        // Still unreachable. Replace the wall's content with the URL-derived
        // placeholder and CLEAR the poisoned summary/tags/embedding, so search
        // stops matching on "you have been blocked" text.
        await c.query(
          `update contents
              set og_title = $2, og_description = null, og_image = null,
                  og_site_name = $3, favicon = $4, extracted_text = null,
                  summary = null, tags = '{}', embedding = null,
                  processing_status = 'done', updated_at = now()
            where id = $1`,
          [r.id, meta.ogTitle, meta.ogSiteName, meta.favicon],
        );
        console.log(`  ~ still blocked: ${r.link.slice(0, 60)} → title ${JSON.stringify(meta.ogTitle)}, poisoned data cleared`);
        stillBlocked++;
        continue;
      }

      // Readable now — rebuild the row the way the worker would.
      const { text } = await extractText(
        detection.type,
        r.link,
        meta.extractedText,
        detection.embedData,
      );

      const fullText = [
        meta.ogTitle && `Title: ${meta.ogTitle}`,
        meta.ogDescription && `Description: ${meta.ogDescription}`,
        text && `Content: ${text}`,
      ].filter(Boolean).join("\n\n");

      let summary: string | null = null;
      let tags: string[] = [];
      let embedding: number[] | null = null;

      if (fullText.length >= 20) {
        const ai = await generateSummaryAndTags(fullText, meta.ogTitle, r.type as any);
        summary = ai.summary;
        tags = ai.tags;
        embedding = await generateEmbedding(
          [meta.ogTitle ?? "", ai.summary, (text ?? "").slice(0, 2000)].join("\n\n"),
        );
      }

      await c.query(
        `update contents
            set og_title = $2, og_description = $3, og_image = $4,
                og_site_name = $5, favicon = $6, extracted_text = $7,
                summary = $8, tags = $9::text[],
                embedding = $10::vector, processing_status = 'done',
                updated_at = now()
          where id = $1`,
        [
          r.id, meta.ogTitle, meta.ogDescription, meta.ogImage, meta.ogSiteName,
          meta.favicon, text, summary, tags,
          embedding ? `[${embedding.join(",")}]` : null,
        ],
      );
      console.log(`  ✓ repaired: ${r.link.slice(0, 55)} → ${JSON.stringify((meta.ogTitle ?? "").slice(0, 45))} | text ${text?.length ?? 0} | embedding ${embedding ? "yes" : "no"}`);
      fixed++;
    } catch (err) {
      console.error(`  ✗ failed: ${r.link.slice(0, 60)} — ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. repaired ${fixed} | still blocked (cleaned) ${stillBlocked} | failed ${failed}`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
