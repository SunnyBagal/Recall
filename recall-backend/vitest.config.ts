import { defineConfig } from "vitest/config";

// Vitest + Supertest suite. Files are named *.vitest.ts so `bun test` (which
// runs the bun:test characterization suite in test/) does not pick them up.
export default defineConfig({
  test: {
    include: ["test-vitest/**/*.vitest.ts"],
    setupFiles: ["./test-vitest/setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one local database.
    fileParallelism: false,
  },
});
