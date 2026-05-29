# Recall Frontend

A React 19 + TypeScript frontend for Recall — a content bookmarking and dashboard app.

## Tech Stack

- **React 19** with React Compiler (automatic memoization)
- **TypeScript** via Vite
- **Tailwind CSS v4** (Vite plugin, no config file)
- **react-router-dom** for client-side routing
- **axios** for API requests
- **bun** as the package manager

## Getting Started

```bash
bun install        # install dependencies
bun run dev        # start dev server with HMR
bun run build      # type-check + production build
bun run preview    # preview production build locally
bun run lint       # run ESLint
```

## Project Structure

```
src/
  App.tsx           # routes
  config.ts         # BACKEND_URL
  pages/
    signup.tsx
    signin.tsx
    dashboard.tsx
  components/
    Button.tsx
    Card.tsx
    Sidebar.tsx
    CreateContent.tsx
    InputBar.tsx
```

## Routes

| Path | Component |
|---|---|
| `/signup` | Signup (default redirect from `/`) |
| `/signin` | Signin |
| `/dashboard` | Dashboard |

## API

Backend defaults to `http://localhost:3000`.

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/signup` | POST | Register `{ username, email, password }` |
| `/api/v1/signin` | POST | Login `{ email, password }` — returns JWT stored in `localStorage` |

## Layout

- Navbar: fixed top, `h-16`
- Sidebar: fixed left, `w-72`, below navbar
- Main content: offset `ml-72 pt-16`
