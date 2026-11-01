// How many indexed rows can an HNSW walk reach? A row with no incoming graph
// links is invisible to every index scan, even an iterative one.
//
//   bun --no-env-file run eval/hnsw-reachability.ts
//
// Walks the whole index from 25 starting points (real document vectors, picked
// deterministically), with limits raised so only the graph itself can stop it.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { RESULTS_DIR, evalDatabaseUrl } from "./lib";

const c = new pg.Client({ connectionString: evalDatabaseUrl() });
await c.connect();
const total = (await c.query("select count(embedding)::int as n from contents")).rows[0].n;
const probes = (
  await c.query("select embedding::text as e from contents where embedding is not null order by md5(link) limit 25")
).rows.map((r) => r.e);

await c.query("set work_mem = '1GB'");
const seen = new Set<string>();
const perWalk: number[] = [];
for (const vector of probes) {
  await c.query(`begin; set local enable_seqscan = off; set local enable_sort = off;
    set local hnsw.iterative_scan = strict_order; set local hnsw.max_scan_tuples = 1000000;
    set local hnsw.scan_mem_multiplier = 100`);
  const r = await c.query("select id from contents order by embedding <=> $1 limit 100000", [vector]);
  await c.query("rollback");
  r.rows.forEach((x) => seen.add(x.id));
  perWalk.push(r.rows.length);
}
await c.end();

const output = {
  indexedRows: total,
  walks: probes.length,
  reachableAcrossAllWalks: seen.size,
  minReachedInOneWalk: Math.min(...perWalk),
  maxReachedInOneWalk: Math.max(...perWalk),
};
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, "hnsw-reachability.json"), JSON.stringify(output, null, 2) + "\n");
console.log(output);
