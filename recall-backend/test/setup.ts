// Preloaded by `bun test` (see bunfig.toml) before any test file or app module.
//
// - JWT_SECRET is read at import time by index.ts and middleware/middleware.ts,
//   so it has to be set here. It is overridden even if a local .env provides
//   one, so tokens are the same on every machine.
// - Every non-loopback fetch fails unless a test stubs it, so a test can never
//   reach the network by accident.
//
// - DNS is faked too. fetchMetadata checks every host with urlGuard, which resolves
//   it first, so without this a test would need the real network, and fixture hosts
//   such as blog.example.com would be refused for not resolving. Fixture hosts get a
//   public address; localhost stays loopback, so the guard's own tests still prove it
//   refuses local targets.
import { mock } from "bun:test";
import { installFetchGuard } from "./helpers/network";

mock.module("node:dns/promises", () => ({
  lookup: async (host: string) => {
    if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
    if (host.endsWith(".invalid")) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return [{ address: "93.184.215.14", family: 4 }];
  },
}));

process.env.JWT_SECRET = "test-jwt-secret";

installFetchGuard();
