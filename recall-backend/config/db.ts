import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";

// What code that uses the database depends on. Both the production
// node-postgres database and the PGlite database used by tests satisfy it.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Startup check, called by the entry points (index.ts, worker.ts, bench) —
// importing this module no longer exits or connects.
export function databaseUrlOrExit(): string {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    console.error("DATABASE_URL is not set in .env");
    process.exit(1);
  };

  return DATABASE_URL;
}

export function createDb(DATABASE_URL: string) {
  return drizzle({
    connection: DATABASE_URL,
    schema,
    // SQL logging on by default (unchanged for normal dev). The benchmark sets
    // DRIZZLE_LOGGER=false so 500+ queries with 1536-dim vector params don't
    // flood stdout.
    logger: process.env.DRIZZLE_LOGGER !== "false"
  });
}
