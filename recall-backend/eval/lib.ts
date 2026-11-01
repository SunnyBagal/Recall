import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Relevance } from "./metrics";

export const EVAL_DIR = import.meta.dir;
export const DATA_DIR = join(EVAL_DIR, "data", "scifact");
export const CACHE_DIR = join(EVAL_DIR, "cache");
export const RESULTS_DIR = join(EVAL_DIR, "results");
export const EVAL_USER_EMAIL = "eval@scifact.example";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const docLink = (id: string) => `https://scifact.example/doc/${id}`;
export const docIdFromLink = (link: string) => link.slice(link.lastIndexOf("/") + 1);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The eval only ever uses EVAL_* URLs, never DATABASE_URL or REDIS_URL, which
 * Bun auto-loads from .env. Anything off this machine is refused.
 */
function localUrl(name: string, fallback: string): string {
  const url = process.env[name] ?? fallback;
  if (!LOOPBACK.has(new URL(url).hostname)) {
    console.error(`Refusing ${name}: the host must be loopback.`);
    process.exit(2);
  }
  return url;
}

export const evalDatabaseUrl = () => {
  const url = localUrl("EVAL_DATABASE_URL", "postgresql://recall@127.0.0.1:54329/recall_eval");
  if (!new URL(url).pathname.includes("eval")) {
    console.error('Refusing EVAL_DATABASE_URL: the database name must contain "eval".');
    process.exit(2);
  }
  return url;
};
export const evalRedisUrl = () => localUrl("EVAL_REDIS_URL", "redis://127.0.0.1:63799");

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`STOP: missing environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

// ---- dataset ---------------------------------------------------------------

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as T);

export interface Doc { _id: string; title: string; text: string }
export interface Query { id: string; text: string; relevant: Relevance }

export function loadCorpus(): Doc[] {
  return readJsonl<Doc>(join(DATA_DIR, "corpus.jsonl"));
}

/** SciFact test split: only queries that have labels in qrels/test.tsv. */
export function loadTestQueries(): Query[] {
  const qrels = new Map<string, Relevance>();
  for (const line of readFileSync(join(DATA_DIR, "qrels", "test.tsv"), "utf8").trim().split("\n").slice(1)) {
    const [qid, docId, score] = line.split("\t") as [string, string, string];
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid)!.set(docId, Number(score));
  }
  return readJsonl<{ _id: string; text: string }>(join(DATA_DIR, "queries.jsonl"))
    .filter((q) => qrels.has(q._id))
    .map((q) => ({ id: q._id, text: q.text, relevant: qrels.get(q._id)! }));
}

/** SciFact train split, used only for choosing settings. */
export function loadTrainQueries(): Query[] {
  const qrels = new Map<string, Relevance>();
  for (const line of readFileSync(join(DATA_DIR, "qrels", "train.tsv"), "utf8").trim().split("\n").slice(1)) {
    const [qid, docId, score] = line.split("\t") as [string, string, string];
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid)!.set(docId, Number(score));
  }
  return readJsonl<{ _id: string; text: string }>(join(DATA_DIR, "queries.jsonl"))
    .filter((q) => qrels.has(q._id))
    .map((q) => ({ id: q._id, text: q.text, relevant: qrels.get(q._id)! }));
}

// ---- append-only disk cache ------------------------------------------------

/** key -> JSON value, one line per entry, so an interrupted run loses nothing. */
export class DiskCache<V> {
  private map = new Map<string, V>();
  private path: string;

  constructor(name: string) {
    mkdirSync(CACHE_DIR, { recursive: true });
    this.path = join(CACHE_DIR, `${name}.jsonl`);
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line) continue;
        const { k, v } = JSON.parse(line);
        this.map.set(k, v);
      }
    }
  }

  get size() {
    return this.map.size;
  }
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, value: V) {
    this.map.set(key, value);
    appendFileSync(this.path, JSON.stringify({ k: key, v: value }) + "\n");
  }
}

export const sha = (...parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const embeddingKey = (text: string) => sha(EMBEDDING_MODEL, text);
