import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import * as schema from "../../db/schema";
import type { Db } from "../../config/db";

export interface TestDb {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

/**
 * In-memory Postgres (PGlite + pgvector) with the real schema applied.
 *
 * The project has no migration journal (it uses `drizzle-kit push`), so the
 * DDL is generated from db/schema.ts with drizzle-kit's own generator — the
 * same source `push` uses. That includes the HNSW and GIN indexes and the
 * generated search_vector column.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite({ extensions: { vector } });
  await client.exec("create extension if not exists vector");

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema),
  );
  for (const statement of statements) {
    await client.exec(statement);
  }

  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

/** 1536-dim unit vector with a single 1 at `i` — orthogonal for different `i`. */
export function oneHot(i: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[i] = 1;
  return v;
}
