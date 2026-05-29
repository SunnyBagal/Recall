# Recall

A link-saving app where every URL becomes a rich, embedded card — YouTube players, tweet cards, GitHub repo previews, article summaries — all searchable by meaning, not just keywords.

Paste a link. Get a card. Ask AI about it later.

---

## What it does

You save a URL. Recall figures out the rest.

- **YouTube link?** → Embedded player + auto-generated transcript + summary
- **Tweet?** → Full Twitter card with engagement data
- **GitHub repo?** → Preview card with description, stars, README content
- **Medium article?** → Clean OG preview + extracted article text
- **Anything else?** → Fetches the page title, description, favicon, and renders a link preview card

Behind the scenes, every saved link goes through an async processing pipeline: the text is extracted, summarized by Claude, auto-tagged into categories (tech, career, system-design, etc.), and converted into a vector embedding. This means you can search your saved links by *meaning* — "that video about caching" finds a video titled "Redis Performance Tips" — and ask an AI that's read all your saved content.

---

## The Stack

| Layer | Tech |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4 |
| State | Zustand (UI state), TanStack Query (server state) |
| Backend | Express 5, TypeScript, Bun runtime |
| Database | PostgreSQL + Drizzle ORM + pgvector |
| Queue | BullMQ + Redis |
| AI | Claude API (summarization, chat), OpenAI (embeddings) |
| Auth | Argon2id + JWT |

---

## Architecture

```
User pastes URL
       │
       ▼
┌──────────────────┐     ┌───────────────────┐
│  React Frontend  │────▶│   Express API     │
│  TanStack Query  │     │   /api/v1/content │
│  + Zustand       │     └─────────┬─────────┘
└──────────────────┘               │
                                   │  1. detectLinkType()   — regex, instant
                                   │  2. fetchMetadata()    — OG tags, 1-3s
                                   │  3. INSERT → PostgreSQL
                                   │  4. Queue job → BullMQ
                                   │  5. Return response → card appears
                                   │
                              ┌────▼─────┐
                              │  Redis   │
                              │ (BullMQ) │
                              └────┬─────┘
                                   │
                              ┌────▼──────────────────────────┐
                              │  Worker (separate process)    │
                              │                               │
                              │  1. Extract text              │
                              │     YouTube → transcript      │
                              │     GitHub  → README          │
                              │     Article → Readability     │
                              │                               │
                              │  2. Claude API                │
                              │     → 2-3 sentence summary    │
                              │     → 2-3 category tags       │
                              │                               │
                              │  3. OpenAI Embeddings         │
                              │     → 1536-dim vector         │
                              │                               │
                              │  4. UPDATE PostgreSQL         │
                              │     status → "done"           │
                              └───────────────────────────────┘
                                   │
                                   │  TanStack Query polls every 5s
                                   │  (only while cards are pending)
                                   ▼
                           Summary + tags appear on card
```

**Search flow:**
```
User types "that video about caching"
       │
       ▼
  Generate query embedding (OpenAI)
       │
       ├──▶ pgvector cosine similarity search (semantic)
       │
       ├──▶ PostgreSQL ILIKE search (keyword fallback)
       │
       └──▶ Reciprocal Rank Fusion (merge + deduplicate)
              │
              ▼
        Ranked results as rich cards
```

**RAG chat flow:**
```
User asks "summarize everything about system design"
       │
       ├──▶ Retrieve top 5 relevant saved links (vector search)
       │
       ├──▶ Build numbered context: [1] "Title" ... [2] "Title" ...
       │
       ├──▶ Stream Claude response via SSE
       │
       └──▶ Parse [1], [2] citations → clickable chips on frontend
```

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (runtime for both frontend and backend)
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) extension
- Redis (for BullMQ job queue)
- [Anthropic API key](https://console.anthropic.com) (for Claude — summarization + chat)
- [OpenAI API key](https://platform.openai.com/api-keys) (for text-embedding-3-small)

### Setup

```bash
# Clone the repo
git clone https://github.com/SunnyBagal/recall.git
cd recall

# Backend
cd backend
bun install
cp .env.example .env   # fill in your keys
bunx drizzle-kit push  # create tables in PostgreSQL

# Frontend
cd ../frontend
bun install
```

### Environment variables (backend `.env`)

```env
JWT_SECRET=your-secret-here
DATABASE_URL=postgresql://user:password@localhost:5432/recall_dev
REDIS_URL=redis://localhost:6379
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

### Run (3 terminals)

```bash
# Terminal 1: API server
cd backend && bun run index.ts

# Terminal 2: Background worker
cd backend && bun run worker.ts

# Terminal 3: Frontend
cd frontend && bun run dev
```

### Database setup

```bash
# Create the database and enable pgvector
psql -c "CREATE DATABASE recall_dev;"
psql recall_dev -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Push the schema
cd backend && bunx drizzle-kit push
```

---

## Features

**Universal link detection** — Paste any URL. The backend classifies it (YouTube, Twitter, Reddit, GitHub, Instagram, article, or generic link) using pure regex pattern matching and extracts the right embed format.

**Rich embedded cards** — YouTube links get an actual player. Tweets render as Twitter cards. GitHub repos show description and stars. Articles show OG image + title + description. Every card shows the site's actual favicon.

**Async AI pipeline** — When you save a link, the card appears instantly. A BullMQ worker running in a separate process extracts the page text, generates a Claude summary, auto-tags by category, and creates a vector embedding. The frontend polls only while cards are processing and stops when everything's done.

**Semantic search** — Type natural language queries. "That video about caching" finds content titled "Redis Performance Tips" because the vector embeddings capture meaning, not just keywords. Combined with keyword fallback via reciprocal rank fusion.

**RAG chat** — Ask questions across all your saved content. "Summarize everything about system design" or "Compare those two React articles." Claude streams answers with numbered citations that link back to the original cards.

**Dynamic sidebar** — Type filters and tag filters are generated dynamically from your actual content. Save 3 YouTube videos and 2 articles? The sidebar shows "YouTube (3)" and "Articles (2)." Tags like "tech," "career," "system-design" appear as the worker processes your links.

**Share brain** — Generate a public link to share your entire collection. Anyone with the link can browse your saved content in a read-only view.

---

## What I Learned Building This

This was the project where a lot of things clicked for me. Not just "I used this tech" but "I understand *why* this tech exists."

### Integrating AI into a real product

This was my first time integrating AI not as a chatbot demo but as an *invisible feature*. The user doesn't see "Claude is summarizing your link" — they see a card that starts as a skeleton and fills in with a summary 5 seconds later. The AI call to Claude happens in a background worker, writes to the database, and the frontend discovers the result via polling. Getting that async loop right — where the user never waits, never sees a loading spinner for AI, and the summary just *appears* — taught me more about product engineering than any tutorial.

The RAG pipeline was the other half. Building retrieval-augmented generation from scratch meant understanding the entire chain: embed the query → cosine similarity in pgvector → format as numbered context → stream from Claude → parse citations on the frontend. Every step has failure modes. What if embeddings aren't generated yet? (Fallback to recent content.) What if the user asks about a specific card? (Look it up directly by ID, don't rely on vector search.) What if Claude hallucinates a citation number? (Only render citations that match actual sources.) Building this defensively was the real lesson.

### The re-render rabbit hole

This one cost me hours and taught me the most.

**The problem:** Cards re-rendered on every refresh. The old tick-counter pattern (`setTick(n => n + 1)`) created a brand-new array in state each time — React saw a new reference and re-rendered every card, even if the data was identical. With embedded YouTube iframes and Twitter widgets, this caused visible flickering.

**Fix 1 — TanStack Query with staleTime:** Replaced the tick-counter with TanStack Query. The cached array is reused for 30 seconds (`staleTime: 30_000`), so the same reference is returned and no re-renders fire unless data actually changes.

**Fix 2 — Smart polling:** Instead of polling on a fixed interval, the query only refetches every 5 seconds when at least one card has `pending`/`processing` status — and stops automatically when everything is done. No unnecessary fetches means no unnecessary re-renders.

**Fix 3 — React Compiler:** `babel-plugin-react-compiler` automatically memoizes every component at build time. The Card component is effectively wrapped in `React.memo` without writing it manually — so even when the parent re-renders, cards whose props haven't changed are skipped entirely.

This taught me that "performance optimization" in React isn't about sprinkling `useMemo` everywhere — it's about understanding *reference identity* and when React actually needs to diff.

### The BullMQ worker pattern

Running the worker as a separate process (`bun run worker.ts`) was a first for me. The mental model shift was significant: the API server and the worker share a database and a Redis queue, but they're completely independent processes. The API can restart without affecting in-progress jobs. The worker can crash and jobs will retry automatically with exponential backoff. I can run 3 workers in parallel and BullMQ distributes jobs between them.

The dead letter queue was the other lesson. When the Claude API model ID was wrong, every job failed 3 times and moved to the DLQ. The content was saved (users could see their cards), the summaries just never appeared. In production, you'd monitor the DLQ and alert on it. This kind of graceful degradation — where a backend failure doesn't break the user experience, just reduces it — is something I now think about in every system I design.

### Extracting data from any URL

Before this project, a "link" was just a string. Now I understand the whole pipeline:

**URL → Type:** Pure regex against known domains. YouTube URLs have 4 different formats (`/watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`). Twitter uses `/status/ID`. GitHub is `/owner/repo`. Instagram is `/p/ID` or `/reel/ID`. For everything else, heuristics: does the path have long hyphenated slugs? Probably an article.

**URL → Metadata:** Fetch the HTML, parse `<meta property="og:title">`, `og:description`, `og:image`, `og:site_name`. Fall back to `<title>` and `<meta name="description">`. Extract the favicon from `<link rel="icon">` or fall back to `/favicon.ico`. For articles, run Mozilla Readability (the same engine Firefox Reader View uses) to strip ads and navigation and get the clean body text.

**URL → Embed:** YouTube's embeddable URL is `/embed/VIDEO_ID`, not `/watch?v=VIDEO_ID`. Twitter doesn't use iframes — it uses a `<blockquote>` plus their `widgets.js` script. Reddit has an embed URL format. Instagram blocks third-party iframes entirely, so you can only show the OG preview. Each platform has its own quirks.

I also learned regex in a practical context for the first time. Not "match an email address" from a tutorial, but "extract a YouTube video ID from 4 different URL formats without matching non-video YouTube pages." Limited scope, but I actually understand capture groups and alternation now.

### Tailwind CSS — the endless toolkit

I went in thinking "it's just utility classes." I came out realizing Tailwind is more of a design system than a CSS framework. Things that surprised me:

- `group` and `group-hover:opacity-100` for showing card actions on hover — no JavaScript needed
- `@container` queries for responsive card grids that respond to the container width, not the viewport
- `transition-[margin]` to animate specific properties when the sidebar or AI panel toggles
- `columns-*` for a masonry-like layout with pure CSS
- `line-clamp-*` for truncating text without JavaScript

There's genuinely no end to it. You can learn the syntax quickly, but using it to build something that *looks* designed (not just styled) is a different skill entirely.

### The sidebar — small feature, big learning

The collapsible sidebar sounds trivial, but it was my first time implementing a layout where multiple panels affect each other. When the sidebar closes, the content grid needs `ml-0` instead of `ml-72` and should animate the transition. When the AI panel opens, the grid also needs `mr-96`. These margins stack: sidebar closed + AI panel open means `ml-0 mr-96`. Sidebar open + AI panel open means `ml-72 mr-96`.

The dynamic filters were the interesting part. The sidebar doesn't have a hardcoded list of types — it computes them from the actual content using `reduce`. Save 5 YouTube links and 2 articles? You see "YouTube (5)" and "Articles (2)." Delete all the articles? That filter disappears. Tags work the same way, generated by Claude's auto-tagging and aggregated dynamically.

### PostgreSQL over MongoDB

I deliberately chose PostgreSQL + Drizzle over MongoDB + Mongoose for this project. The reason: I wanted to learn actual SQL and relational modeling, not document-store patterns.

The payoff was immediate. Foreign keys with `ON DELETE CASCADE` mean deleting a user automatically cleans up all their content and share links — something MongoDB doesn't enforce. Enums mean the database rejects invalid content types. pgvector means semantic search lives in the same database as my content, queryable in the same SQL statement with the same WHERE clauses. No separate vector database, no cross-database joins.

Drizzle specifically taught me what an ORM should feel like. Every query is type-safe — if I write `eq(users.email, 123)`, TypeScript catches it at compile time because `email` is `text`, not `integer`. The `.returning()` pattern for getting the inserted row back, the `and()`/`or()` composition for WHERE clauses, the explicit `.innerJoin()` instead of Mongoose's magic `.populate()` — all of it forced me to understand what SQL is actually happening under the hood.

---

## Project Structure

```
recall/
├── backend/
│   ├── index.ts                    # Express server + all routes
│   ├── worker.ts                   # BullMQ worker (separate process)
│   ├── config/
│   │   ├── db.ts                   # Drizzle connection
│   │   └── queue.ts                # BullMQ + Redis setup
│   ├── db/
│   │   └── schema.ts               # PostgreSQL tables (Drizzle)
│   ├── middleware/
│   │   └── middleware.ts            # JWT auth
│   └── services/
│       ├── linkDetector.ts          # URL → content type (regex)
│       ├── metadataFetcher.ts       # URL → OG tags + article text
│       ├── textExtractor.ts         # YouTube transcripts, GitHub READMEs
│       ├── aiProcessor.ts           # Claude summarization + tagging
│       └── embeddings.ts            # OpenAI vector embeddings
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # Router + QueryClientProvider
│   │   ├── components/
│   │   │   ├── Card.tsx             # Universal card with dynamic favicon
│   │   │   ├── InputBar.tsx         # URL paste + search
│   │   │   ├── Sidebar.tsx          # Dynamic filters + profile
│   │   │   ├── AskAIPanel.tsx       # RAG chat with SSE streaming
│   │   │   ├── CreateContent.tsx    # Add content modal
│   │   │   └── ErrorBoundary.tsx    # Graceful error handling
│   │   ├── hooks/
│   │   │   ├── useContent.tsx       # TanStack Query + mutations
│   │   │   └── useSearch.ts         # Semantic search hook
│   │   ├── stores/
│   │   │   ├── authStore.ts         # Zustand auth state
│   │   │   └── uiStore.ts          # Zustand UI state
│   │   ├── lib/
│   │   │   └── api.ts              # Axios instance + interceptors
│   │   └── pages/
│   │       ├── dashboard.tsx        # Main app
│   │       ├── shared.tsx           # Public share view
│   │       ├── signin.tsx
│   │       └── signup.tsx
```

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/signup` | No | Create account |
| POST | `/api/v1/signin` | No | Get JWT token |
| POST | `/api/v1/content` | Yes | Save a URL (auto-detects type, fetches metadata, queues processing) |
| GET | `/api/v1/content` | Yes | Get all saved content with user join |
| DELETE | `/api/v1/content` | Yes | Delete content by ID |
| GET | `/api/v1/search?q=...` | Yes | Hybrid semantic + keyword search |
| POST | `/api/v1/chat` | Yes | RAG chat with SSE streaming |
| POST | `/api/v1/brain/share` | Yes | Create/remove share link |
| GET | `/api/v1/brain/:hash` | No | View shared content (public) |

---

## License

MIT

---

Built by [Sunny Bagal](https://github.com/SunnyBagal)
