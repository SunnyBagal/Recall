// ─── Search Hook (TanStack Query) ───────────────────────────────
// Manages the search state. When the user types in the InputBar
// and it doesn't look like a URL, we trigger a semantic search.
//
// Uses `enabled: !!query` — the query only fires when there's a
// search term. When the user clears the search, we disable the
// query and the dashboard shows all content again.

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Content } from "./useContent";

async function searchContent(query: string): Promise<Content[]> {
  const res = await api.get("/api/v1/search", { params: { q: query } });
  return res.data.results;
}

export function useSearch(query: string) {
  const result = useQuery({
    queryKey: ["search", query],
    queryFn: () => searchContent(query),
    // Only run the query when there's a non-empty search term
    enabled: !!query.trim(),
    // Don't refetch search results aggressively — they don't change often
    staleTime: 60_000,
  });

  return {
    results: result.data ?? [],
    isSearching: result.isLoading && result.fetchStatus !== "idle",
    error: result.error,
  };
}