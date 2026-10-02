// Preloaded by `bun test` (see bunfig.toml) before any test file or app module.
//
// - JWT_SECRET is read at import time by index.ts and middleware/middleware.ts,
//   so it has to be set here. It is overridden even if a local .env provides
//   one, so tokens are the same on every machine.
// - Every non-loopback fetch fails unless a test stubs it, so a test can never
//   reach the network by accident.
import { installFetchGuard } from "./helpers/network";

process.env.JWT_SECRET = "test-jwt-secret";

installFetchGuard();
