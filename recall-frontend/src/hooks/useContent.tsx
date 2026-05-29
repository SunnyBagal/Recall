// ─── Content Hooks (TanStack Query) ─────────────────────────────
// Replaces the old manual useState + useEffect + tick-counter pattern.
//
// Before (manual approach):
//   const [contents, setContents] = useState([]);
//   const [tick, setTick] = useState(0);
//   useEffect(() => { fetch().then(setContents) }, [tick]);
//   const refresh = () => setTick(n => n + 1);
//
// After (TanStack Query):
//   const { data } = useQuery({ queryKey: ["content"], queryFn: fetchContent });
//   queryClient.invalidateQueries({ queryKey: ["content"] });  // to refresh
//
// What you gain:
// 1. Automatic caching — navigating away and back doesn't re-fetch if data is fresh
// 2. Background refetch — data updates silently without loading spinners
// 3. Conditional polling — refetch every 5s ONLY when cards are still processing
// 4. Deduplication — 3 components reading "content" = 1 network request
// 5. Optimistic updates — card appears before the server confirms (on mutation)

import { api } from "../lib/api";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

// ─── Types ──────────────────────────────────────────────────────

export type ContentType =
  | "youtube"
  | "twitter"
  | "reddit"
  | "github"
  | "instagram"
  | "article"
  | "link";

export type ProcessingStatus = "pending" | "processing" | "done" | "failed";

export type Content = {
  id: string;
  title: string | null;
  link: string;
  type: ContentType;
  tags: string[] | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogSiteName: string | null;
  favicon: string | null;
  embedUrl: string | null;
  summary: string | null;
  extractedText: string | null;
  processingStatus: ProcessingStatus;
  createdAt: string;
  username: string;
};

// ─── Fetch all content ──────────────────────────────────────────

async function fetchContent(): Promise<Content[]> {
  const res = await api.get("/api/v1/content");
  return res.data.content;
}

export function useContent() {
  const query = useQuery({
    queryKey: ["content"],
    queryFn: fetchContent,

    // ── Smart polling for processing status ──
    // When any card has processingStatus "pending" or "processing",
    // refetch every 5 seconds so summaries/tags appear when ready.
    // Once everything is "done", polling stops automatically.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasPending = data.some(
        (c) => c.processingStatus === "pending" || c.processingStatus === "processing"
      );
      return hasPending ? 5000 : false;
    },

    // Keep showing old data while refetching in the background
    // (no loading spinner on refetch, only on initial load)
    staleTime: 30_000, // data considered fresh for 30 seconds
  });

  return {
    contents: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

// ─── Create content mutation ────────────────────────────────────
// Used by InputBar and CreateContent modal.

interface CreateContentInput {
  link: string;
  title?: string;
}

export function useCreateContent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateContentInput) => {
      const res = await api.post("/api/v1/content", input);
      return res.data;
    },

    // ── After successful save, refetch the content list ──
    // invalidateQueries marks the "content" cache as stale,
    // which triggers an automatic refetch. This replaces the
    // old tick-counter pattern.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}

// ─── Delete content mutation ────────────────────────────────────

export function useDeleteContent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete("/api/v1/content", { data: { contentId } });
    },

    // ── Optimistic delete ──
    // Remove the card from the UI immediately, before the server confirms.
    // If the server request fails, roll back to the previous state.
    onMutate: async (contentId) => {
      // Cancel any in-flight refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: ["content"] });

      // Snapshot the previous value (for rollback)
      const previous = queryClient.getQueryData<Content[]>(["content"]);

      // Optimistically remove the card
      queryClient.setQueryData<Content[]>(["content"], (old) =>
        old ? old.filter((c) => c.id !== contentId) : []
      );

      return { previous };
    },

    // If the server fails, roll back
    onError: (_err, _contentId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["content"], context.previous);
      }
    },

    // Always refetch after error or success to make sure we're in sync
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}