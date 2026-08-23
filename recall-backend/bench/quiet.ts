// Side-effect module: silence drizzle SQL logging for benchmark runs.
// MUST be imported before ../config/db so the flag is set before drizzle()
// reads it (see config/db.ts). Importing it first in bench-search.ts guarantees
// the ordering under ESM/Bun module evaluation.
process.env.DRIZZLE_LOGGER = process.env.DRIZZLE_LOGGER ?? "false";
