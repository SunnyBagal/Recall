import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import pg from "pg";
import { createDb, type Db } from "../config/db";
import * as schema from "../db/schema";

const DEFAULT_URL = "postgresql://recall@127.0.0.1:54329/recall_test";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Real Postgres + pgvector. Refuses anything that is not on this machine. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const { hostname, pathname } = new URL(url);
  if (!LOOPBACK.has(hostname) || !pathname.includes("test")) {
    throw new Error(
      `Refusing TEST_DATABASE_URL: host must be loopback and the database name must contain "test"`,
    );
  }
  return url;
}

/** Drops and recreates the schema from db/schema.ts, then returns a client. */
export async function freshDatabase(): Promise<{ db: Db; raw: pg.Client; close(): Promise<void> }> {
  const url = testDatabaseUrl();
  const raw = new pg.Client({ connectionString: url });
  try {
    await raw.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach local Postgres at ${url}. Run eval/local-services.sh start. (${(err as Error).message})`,
    );
  }

  await raw.query("drop schema public cascade; create schema public; create extension vector");
  const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  for (const statement of statements) await raw.query(statement);

  const db = createDb(url) as unknown as Db & { $client: pg.Pool };
  return {
    db,
    raw,
    async close() {
      await db.$client.end();
      await raw.end();
    },
  };
}

/** 1536-dim unit vector with cosine similarity `cos` to basis vector `i`. */
export function vectorNear(i: number, cos: number, orthogonalAxis: number = i + 1): number[] {
  const v = new Array<number>(1536).fill(0);
  v[i] = cos;
  v[orthogonalAxis] = Math.sqrt(1 - cos * cos);
  return v;
}
