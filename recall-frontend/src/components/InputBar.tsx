import { useState } from "react";
import { EnterIcon } from "../icons/EnterIcon";
import { useCreateContent } from "../hooks/useContent";
import { useUIStore } from "../stores/uiStore";
import { X } from "lucide-react";

function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[a-zA-Z0-9][\w.-]*\.[a-z]{2,}(\/\S*)?$/i.test(trimmed)) return true;
  return false;
}

export function InputBar() {
  const [value, setValue] = useState("");
  const createContent = useCreateContent();
  const { searchQuery, setSearchQuery, clearSearch } = useUIStore();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || createContent.isPending) return;

    if (looksLikeUrl(trimmed)) {
      const link = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
      createContent.mutate({ link }, { onSuccess: () => setValue("") });
    } else {
      setSearchQuery(trimmed);
    }
  }

  function handleClearSearch() {
    clearSearch();
    setValue("");
  }

  return (
    <form className="flex items-center gap-2 w-full min-w-0" onSubmit={handleSubmit}>
      <div className="flex-1 min-w-0 relative">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste a link or search your Recall..."
          className="w-full h-10 border border-white rounded-lg bg-transparent text-white placeholder:text-gray-500 px-4 pr-10 outline-none focus:ring-2 focus:ring-white/30 transition-shadow"
          disabled={createContent.isPending}
        />
        {searchQuery && (
          <button
            type="button"
            onClick={handleClearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-white transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>
      <button
        type="submit"
        disabled={createContent.isPending || !value.trim()}
        className="shrink-0 w-24 h-10 inline-flex items-center justify-center rounded-xl bg-gray-100 text-black hover:bg-gray-200 active:bg-gray-300 transition-colors disabled:opacity-50"
      >
        {createContent.isPending ? (
          <div className="w-5 h-5 border-2 border-gray-400 border-t-black rounded-full animate-spin" />
        ) : (
          <EnterIcon />
        )}
      </button>
    </form>
  );
}
