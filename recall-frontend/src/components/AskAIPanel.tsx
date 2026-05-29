// ─── Ask AI Panel ───────────────────────────────────────────────
// Full RAG chat panel:
// 1. User types a question
// 2. Backend retrieves relevant saved links via vector search
// 3. Claude generates an answer citing those links
// 4. Response streams in via SSE (Server-Sent Events)
// 5. Citations render as clickable chips linking to the original cards

import { useState, useRef, useEffect } from "react";
import { BACKEND_URL } from "../config";
import type { Content, ContentType } from "../hooks/useContent";
import { useUIStore, MIN_AI_PANEL_WIDTH, MAX_AI_PANEL_WIDTH } from "../stores/uiStore";
import { X, Send, Loader2 } from "lucide-react";

export interface CardContext {
  title: string | null;
  link: string;
  type: ContentType;
}

interface AskAIPanelProps {
  open: boolean;
  onClose: () => void;
  context: Content | null;
  onClearContext: () => void;
}

interface Citation {
  index: number;
  id: string;
  title: string;
  link: string;
  type: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

export function AskAIPanel({ open, onClose, context, onClearContext }: AskAIPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contextHandled = useRef<string | null>(null);
  const aiPanelWidth = useUIStore((s) => s.aiPanelWidth);
  const setAiPanelWidth = useUIStore((s) => s.setAiPanelWidth);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const max = Math.min(MAX_AI_PANEL_WIDTH, window.innerWidth * 0.6);
      const next = Math.max(MIN_AI_PANEL_WIDTH, Math.min(max, window.innerWidth - ev.clientX));
      setAiPanelWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 300);
  }, [open]);

  // When a card context is set, auto-ask about it (only once per card)
  useEffect(() => {
    if (context && open && contextHandled.current !== context.id) {
      contextHandled.current = context.id;
      const prompt = `Tell me about: "${context.title ?? context.link}"`;
      sendMessage(prompt, context.id);
    }
  }, [context, open]);

  async function sendMessage(text?: string, cardId?: string) {
    const messageText = text ?? input.trim();
    if (!messageText || isStreaming) return;

    const userMessage: ChatMessage = { role: "user", content: messageText };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsStreaming(true);

    const history = messages.map(({ role, content }) => ({ role, content }));

    try {
      const token = localStorage.getItem("token");
      const response = await fetch(`${BACKEND_URL}/api/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token ?? "",
        },
        body: JSON.stringify({
          message: messageText,
          history,
          // Send the specific card ID so backend can look it up directly
          // instead of relying purely on vector search
          cardId: cardId ?? context?.id,
        }),
      });

      if (!response.ok) throw new Error("Chat request failed");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let assistantText = "";
      let citations: Citation[] = [];
      let buffer = "";

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const dataLine = line.replace(/^data: /, "").trim();
          if (!dataLine) continue;

          try {
            const event = JSON.parse(dataLine);

            if (event.type === "citations") {
              citations = event.citations;
            } else if (event.type === "text") {
              assistantText += event.text;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: assistantText,
                  citations,
                };
                return updated;
              });
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      console.error("Chat error:", err);
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { role: "assistant", content: "Sorry, something went wrong. Please try again." },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <div
      style={{ width: aiPanelWidth }}
      className={`fixed top-16 right-0 bottom-0 bg-mybackg border-l border-white z-40 flex flex-col transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-white/30 transition-colors z-10"
        aria-label="Resize panel"
      />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h3 className="font-semibold text-white">Ask AI</h3>
        <button onClick={onClose} className="p-1 hover:bg-white/10 rounded transition-colors text-gray-400 hover:text-white">
          <X size={18} />
        </button>
      </div>

      {/* Context badge */}
      {context && (
        <div className="px-4 py-2 bg-white/5 border-b border-white/10 flex items-center gap-2">
          <span className="text-xs text-gray-300 truncate flex-1">
            Asking about: {context.title ?? context.link}
          </span>
          <button onClick={() => { onClearContext(); contextHandled.current = null; }} className="p-0.5 hover:bg-white/10 rounded">
            <X size={14} className="text-gray-400" />
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 mt-12">
            <p className="text-sm">Ask anything about your saved links.</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-white text-black"
                  : "bg-white/10 text-gray-200"
              }`}
            >
              <MessageContent content={msg.content} citations={msg.citations} />
            </div>
          </div>
        ))}

        {isStreaming && messages[messages.length - 1]?.content === "" && (
          <div className="flex justify-start">
            <div className="bg-white/10 rounded-2xl px-4 py-2.5">
              <Loader2 size={16} className="animate-spin text-gray-400" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-white/10 px-4 py-3">
        <form onSubmit={(e) => { e.preventDefault(); sendMessage(); }} className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your saved content..."
            className="flex-1 h-10 px-4 rounded-xl border border-white/20 bg-white/5 text-white text-sm outline-none focus:border-white/40 placeholder:text-gray-500 transition"
            disabled={isStreaming}
          />
          <button
            type="submit"
            disabled={isStreaming || !input.trim()}
            className="h-10 w-10 flex items-center justify-center rounded-xl bg-white text-black hover:bg-gray-200 disabled:opacity-30 transition-colors"
          >
            <Send size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}

function MessageContent({ content, citations }: { content: string; citations?: Citation[] }) {
  if (!citations || citations.length === 0) {
    return <span className="whitespace-pre-wrap">{content}</span>;
  }

  const parts = content.split(/(\[\d+\])/g);

  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+)\]$/);
        if (match) {
          const citIndex = parseInt(match[1]);
          const citation = citations.find((c) => c.index === citIndex);
          if (citation) {
            return (
              <a
                key={i}
                href={citation.link}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center px-1.5 py-0.5 mx-0.5 text-xs font-medium bg-blue-500/20 text-blue-300 rounded-md hover:bg-blue-500/30 transition-colors"
                title={citation.title}
              >
                {citIndex}
              </a>
            );
          }
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}
