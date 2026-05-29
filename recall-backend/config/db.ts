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
  logger: true  
});
