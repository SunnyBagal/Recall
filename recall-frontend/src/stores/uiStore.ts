import { create } from "zustand";
import type { Content, ContentType } from "../hooks/useContent";

interface UIState {
  
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  
  activeFilter: ContentType | null;
  setActiveFilter: (filter: ContentType | null) => void;

  
  activeTag: string | null;
  setActiveTag: (tag: string | null) => void;

  
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  clearSearch: () => void;

  
  aiPanelOpen: boolean;
  toggleAiPanel: () => void;
  closeAiPanel: () => void;
  aiPanelWidth: number;
  setAiPanelWidth: (width: number) => void;
  activeCard: Content | null;
  askAboutCard: (card: Content) => void;
  clearActiveCard: () => void;
}

export const MIN_AI_PANEL_WIDTH = 327;
export const MAX_AI_PANEL_WIDTH = 800;

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  activeFilter: null,
  setActiveFilter: (filter) => set({ activeFilter: filter }),

  activeTag: null,
  setActiveTag: (tag) => set({ activeTag: tag }),

  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),
  clearSearch: () => set({ searchQuery: "" }),

  aiPanelOpen: false,
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  closeAiPanel: () => set({ aiPanelOpen: false }),
  aiPanelWidth: MIN_AI_PANEL_WIDTH,
  setAiPanelWidth: (width) => set({ aiPanelWidth: width }),
  activeCard: null,
  askAboutCard: (card) => set({ activeCard: card, aiPanelOpen: true }),
  clearActiveCard: () => set({ activeCard: null }),
}));
