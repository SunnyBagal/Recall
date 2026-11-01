// Downloads BEIR SciFact into eval/data/scifact and verifies its shape.
//   bun --no-env-file run eval/download.ts
// Exits non-zero on a blocked download or a mismatch. It never synthesizes data.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL_ =
  "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip";
const DATA = join(import.meta.dir, "data");
const ZIP = join(DATA, "scifact.zip");

mkdirSync(DATA, { recursive: true });

if (!existsSync(ZIP)) {
  const res = await fetch(URL_);
  if (!res.ok) {
    console.error(`Download failed: HTTP ${res.status} from ${URL_}`);
    process.exit(1);
  }
  writeFileSync(ZIP, new Uint8Array(await res.arrayBuffer()));
}

const md5 = createHash("md5").update(readFileSync(ZIP)).digest("hex");

// -n: never overwrite; -d keeps extraction inside the data directory.
const unzip = Bun.spawnSync(["unzip", "-q", "-n", ZIP, "-d", DATA]);
if (unzip.exitCode !== 0) {
  console.error(`unzip failed: ${unzip.stderr.toString()}`);
  process.exit(1);
}

const lines = (p: string) =>
  readFileSync(join(DATA, "scifact", p), "utf8").trim().split("\n");
const corpus = lines("corpus.jsonl").length;
const queries = lines("queries.jsonl").length;
const qrels = lines("qrels/test.tsv").slice(1);
const testQueries = new Set(qrels.map((l) => l.split("\t")[0])).size;

console.log(
  JSON.stringify({ url: URL_, md5, corpus, queriesAll: queries, testQueries, testQrels: qrels.length }),
);
