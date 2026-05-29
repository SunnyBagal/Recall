import { useState, useEffect } from "react";
import { X, Link2, Check, Loader2 } from "lucide-react";
import { api } from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Phase =
  | { status: "loading" }
  | { status: "shared"; url: string }
  | { status: "error"; message: string };

export function ShareBrainModal({ open, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setPhase({ status: "loading" });
      createShare();
    }
  }, [open]);

  async function createShare() {
    setPhase({ status: "loading" });
    try {
      const res = await api.post("/api/v1/brain/share", { share: true });
      const url = `${window.location.origin}/share/${res.data.hash}`;
      setPhase({ status: "shared", url });
    } catch {
      setPhase({ status: "error", message: "Failed to create share link. Please try again." });
    }
  }

  async function stopSharing() {
    setPhase({ status: "loading" });
    try {
      await api.post("/api/v1/brain/share", { share: false });
      onClose();
    } catch {
      setPhase({ status: "error", message: "Failed to stop sharing. Please try again." });
    }
  }

  async function copyLink(url: string) {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#0f0f1a] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-white font-semibold text-lg">Share your brain</h2>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {phase.status === "loading" && (
          <div className="flex flex-col items-center justify-center py-10 gap-3">
            <Loader2 size={24} className="animate-spin text-gray-400" />
            <p className="text-sm text-gray-500">Generating your link…</p>
          </div>
        )}

        {phase.status === "shared" && (
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Anyone with this link can browse your saved content — read-only, no account needed.
            </p>

            
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3">
              <Link2 size={13} className="text-gray-500 shrink-0" />
              <span className="text-sm text-gray-300 truncate flex-1 font-mono">
                {phase.url}
              </span>
            </div>

            
            <div className="flex gap-2">
              <button
                onClick={() => phase.status === "shared" && copyLink(phase.url)}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-white text-black text-sm font-medium hover:bg-gray-100 transition-colors"
              >
                {copied ? <Check size={14} /> : <Link2 size={14} />}
                {copied ? "Copied!" : "Copy link"}
              </button>
              <button
                onClick={stopSharing}
                className="flex-1 py-2.5 rounded-xl border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/10 transition-colors"
              >
                Stop sharing
              </button>
            </div>
          </div>
        )}

        {phase.status === "error" && (
          <div className="space-y-4">
            <p className="text-sm text-red-400">{phase.message}</p>
            <button
              onClick={createShare}
              className="w-full py-2.5 rounded-xl border border-white/10 text-gray-300 text-sm font-medium hover:bg-white/5 transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
