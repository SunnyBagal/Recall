

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
    
    enabled: !!query.trim(),
    
    staleTime: 60_000,
  });

  return {
    results: result.data ?? [],
    isSearching: result.isLoading && result.fetchStatus !== "idle",
    error: result.error,
  };
}
