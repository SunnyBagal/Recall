// Runs before every test file and before any app module is imported.
//
// worker.ts imports "dotenv/config", which would copy recall-backend/.env into
// process.env, including whatever DATABASE_URL and REDIS_URL point at. dotenv
// never overrides a variable that is already set, so pinning them here keeps
// the real ones out of the test process. Nothing in the suite reads these: the
// integration tests use TEST_DATABASE_URL, gated to loopback in pg.ts.
import { installFetchGuard } from "../test/helpers/network";

process.env.DATABASE_URL = "postgresql://blocked-in-tests@127.0.0.1:1/none";
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.DRIZZLE_LOGGER = "false";

// Any non-loopback fetch throws unless a test stubs it.
installFetchGuard();
