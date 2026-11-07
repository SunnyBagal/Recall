// Characterization tests: these assert what signup/signin do today, oddities
// included — not what they should do.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import { createTestApp, type TestApp } from "./helpers/app";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.close();
});

describe("POST /api/v1/signup", () => {
  test("creates a user with an argon2id hash and returns its id", async () => {
    const res = await t.request("POST", "/api/v1/signup", {
      body: { username: "ada", email: "ada@example.com", password: "hunter2hunter2" },
    });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("User created");

    const [row] = await t.db.select().from(users).where(eq(users.id, res.body.userId));
    expect(row!.username).toBe("ada");
    expect(row!.email).toBe("ada@example.com");
    expect(row!.password).toStartWith("$argon2id$v=19$m=19456,t=2,p=1$");
  });

  test("requires username, email and password", async () => {
    const res = await t.request("POST", "/api/v1/signup", {
      body: { username: "ada", email: "ada2@example.com" },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Username, email and password are required" });
  });

  test("a duplicate email returns 409", async () => {
    // drizzle wraps driver errors in DrizzleQueryError, so the handler reads the
    // unique_violation code (23505) from err.cause.
    const res = await t.request("POST", "/api/v1/signup", {
      body: { username: "ada-again", email: "ada@example.com", password: "hunter2hunter2" },
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: "Email already taken" });
  });

  test("a duplicate username is accepted (only email is unique)", async () => {
    const res = await t.request("POST", "/api/v1/signup", {
      body: { username: "ada", email: "other-ada@example.com", password: "hunter2hunter2" },
    });

    expect(res.status).toBe(201);
  });
});

describe("POST /api/v1/signin", () => {
  beforeAll(async () => {
    await t.request("POST", "/api/v1/signup", {
      body: { username: "grace", email: "grace@example.com", password: "correct horse" },
    });
  });

  test("signs in by username and returns a 24h token carrying the userId", async () => {
    const res = await t.request("POST", "/api/v1/signin", {
      body: { username: "grace", password: "correct horse" },
    });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["token"]);

    const [row] = await t.db.select().from(users).where(eq(users.email, "grace@example.com"));
    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    expect(payload.userId).toBe(row!.id);
    expect(payload.exp! - payload.iat!).toBe(24 * 60 * 60);
  });

  test("signs in by email", async () => {
    const res = await t.request("POST", "/api/v1/signin", {
      body: { email: "grace@example.com", password: "correct horse" },
    });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });

  test("requires an email or a username", async () => {
    const res = await t.request("POST", "/api/v1/signin", { body: { password: "correct horse" } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Email or username required" });
  });

  test("an unknown user and a wrong password both get the same 401", async () => {
    const unknown = await t.request("POST", "/api/v1/signin", {
      body: { username: "nobody", password: "correct horse" },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ message: "Invalid credentials" });

    const wrong = await t.request("POST", "/api/v1/signin", {
      body: { username: "grace", password: "wrong" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ message: "Invalid credentials" });
  });

  test("a missing password for an existing user is a 500", async () => {
    const res = await t.request("POST", "/api/v1/signin", { body: { username: "grace" } });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: "Internal server error" });
  });
});
