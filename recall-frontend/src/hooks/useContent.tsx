

import { api } from "../lib/api";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

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

async function fetchContent(): Promise<Content[]> {
  const res = await api.get("/api/v1/content");
  return res.data.content;
}

export function useContent() {
  const query = useQuery({
    queryKey: ["content"],
    queryFn: fetchContent,

    
    
    
    
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const hasPending = data.some(
        (c) => c.processingStatus === "pending" || c.processingStatus === "processing"
      );
      return hasPending ? 5000 : false;
    },

    
    
    staleTime: 30_000, 
  });

  return {
    contents: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

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

    
    
    
    
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}

export function useDeleteContent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (contentId: string) => {
      await api.delete("/api/v1/content", { data: { contentId } });
    },

    
    
    
    onMutate: async (contentId) => {
      
      await queryClient.cancelQueries({ queryKey: ["content"] });

      
      const previous = queryClient.getQueryData<Content[]>(["content"]);

      
      queryClient.setQueryData<Content[]>(["content"], (old) =>
        old ? old.filter((c) => c.id !== contentId) : []
      );

      return { previous };
    },

    
    onError: (_err, _contentId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["content"], context.previous);
      }
    },

    
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}
