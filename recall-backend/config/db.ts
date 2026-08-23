import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";

const DATABASE_URL = process.env.DATABASE_URL;
 
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set in .env");
  process.exit(1);
};
 
export const db = drizzle({
  connection: DATABASE_URL,
  schema,
  // SQL logging on by default (unchanged for normal dev). The benchmark sets
  // DRIZZLE_LOGGER=false so 500+ queries with 1536-dim vector params don't
  // flood stdout.
  logger: process.env.DRIZZLE_LOGGER !== "false"
});
