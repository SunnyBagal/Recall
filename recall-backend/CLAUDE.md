# recall-backend

A REST API backend built with Bun, Express, and MongoDB Atlas. Uses JWT for authentication and argon2id for password hashing.

## Getting Started

```bash
bun install
```

Copy `.env.example` to `.env` and fill in the required values.

```bash
bun run index.ts
```

Server runs on `PORT` (defaults to `3005`).

## Scripts

| Command | Description |
|---|---|
| `bun run index.ts` | Start the server |
| `bun --hot index.ts` | Start with hot reload |
| `bun test` | Run tests |
| `bun test <path>` | Run a specific test file |

## Environment Variables

| Key | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Secret used to sign JWT tokens |
| `MONGO_KEY` | Yes | MongoDB Atlas connection string |
| `PORT` | No | Port to listen on (default: 3005) |

Bun auto-loads `.env` — do not use `dotenv`.

## Project Structure

```
index.ts              # Express app and route handlers
config/db.ts          # MongoDB connection helper
model/database.ts     # Mongoose schemas and models
middleware/middleware.ts  # JWT auth middleware
schemas/authSchema.ts # Zod request validation schemas
types/express.d.ts    # Express type augmentations
```

## Stack

- **Runtime**: Bun
- **Framework**: Express
- **Database**: MongoDB Atlas via Mongoose
- **Auth**: JWT
- **Password hashing**: argon2id
- **Validation**: Zod
