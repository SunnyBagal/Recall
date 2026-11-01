import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { contents } from "./schema";
import { sharedContentColumns } from "./sharedContent";

describe("sharedContentColumns", () => {
  test("matches the fields the shared page reads", () => {
    const page = readFileSync(
      join(import.meta.dir, "../../recall-frontend/src/pages/shared.tsx"),
      "utf8",
    );
    const used = new Set([...page.matchAll(/\bitem\.(\w+)/g)].map((m) => m[1]));
    expect(Object.keys(sharedContentColumns).sort()).toEqual([...used].sort() as string[]);
  });

  test("query selects only those columns", () => {
    const { sql } = drizzle.mock().select(sharedContentColumns).from(contents).toSQL();
    for (const col of ["extracted_text", "embedding", "user_id", "search_vector", "created_at", "updated_at"]) {
      expect(sql).not.toContain(`"${col}"`);
    }
    expect(sql).toContain('"processing_status"');
  });
});
