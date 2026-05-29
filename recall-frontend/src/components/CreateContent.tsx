import { useEffect, useState } from "react";
import { CrossIcon } from "../icons/CrossIcon";
import Button from "./Button";
import { useCreateContent } from "../hooks/useContent";

export interface CreateContentModelProps {
  open: boolean;
  onClose: () => void;
}

export function CreateContentModel({ open, onClose }: CreateContentModelProps) {
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const createContent = useCreateContent();

  useEffect(() => {
    if (open) {
      setTitle("");
      setLink("");
      setError("");
    }
  }, [open]);

  if (!open) return null;

  function addContent() {
    if (!link.trim()) {
      setError("Please enter a URL");
      return;
    }
    setError("");

    const normalizedLink = link.trim().startsWith("http")
      ? link.trim()
      : `https://${link.trim()}`;

    createContent.mutate(
      { link: normalizedLink, ...(title.trim() && { title: title.trim() }) },
      {
        onSuccess: () => onClose(),
        onError: () => setError("Failed to save. Check the URL and try again."),
      }
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-slate-500 opacity-60" onClick={onClose} />
      <div className="relative bg-white p-6 rounded-xl w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Add content</h2>
          <button onClick={onClose} aria-label="Close" className="cursor-pointer">
            <CrossIcon size="lg" />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              URL <span className="text-red-500">*</span>
            </label>
            <input
              placeholder="https://youtube.com/watch?v=..."
              value={link} type="url"
              className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:border-black transition"
              onChange={(e) => setLink(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 mb-1 block">
              Title <span className="text-gray-400">(optional — auto-detected)</span>
            </label>
            <input
              placeholder="Custom title for this link"
              value={title} type="text"
              className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:border-black transition"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>

        <p className="text-xs text-gray-400 mt-3">
          Paste any URL the type is detected automatically.
        </p>

        {error && <p className="text-sm text-red-500 mt-2">{error}</p>}

        <div className="flex justify-end mt-4">
          <Button
            variant="primary"
            text={createContent.isPending ? "Saving..." : "Save"}
            size="md"
            onClick={addContent}
            disabled={createContent.isPending || !link.trim()}
          />
        </div>
      </div>
    </div>
  );
}
