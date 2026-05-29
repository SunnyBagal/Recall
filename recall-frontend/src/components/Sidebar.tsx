import { useUIStore } from "../stores/uiStore";
import { useContent, type ContentType } from "../hooks/useContent";
import { useAuthStore } from "../stores/authStore";
import { SidebarContent } from "./SidebarContents";
import { TwitterIcon } from "../icons/TwitterIcon";
import { YoutubeIcon } from "../icons/YoutubeIcon";
import { InstagramIcon } from "../icons/InstagramIcon";
import { GithubIcon } from "../icons/GithubIcon";
import { Globe, FileText, MessageSquare, Hash, LogOut } from "lucide-react";
import { ShareIcon } from "../icons/ShareIcon";
import { ShareBrainModal } from "./ShareBrainModal";
import { type ReactElement, useState } from "react";
import { useNavigate } from "react-router-dom";

const typeConfig: Record<ContentType, { label: string; icon: ReactElement }> = {
  youtube:   { label: "YouTube",   icon: <YoutubeIcon /> },
  twitter:   { label: "Twitter/X", icon: <TwitterIcon /> },
  reddit:    { label: "Reddit",    icon: <MessageSquare size={20} /> },
  github:    { label: "GitHub",    icon: <GithubIcon /> },
  instagram: { label: "Instagram", icon: <InstagramIcon /> },
  article:   { label: "Articles",  icon: <FileText size={20} /> },
  link:      { label: "Links",     icon: <Globe size={20} /> },
};

export function Sidebar() {
  const { contents } = useContent();
  const { activeFilter, setActiveFilter, sidebarOpen, activeTag, setActiveTag } = useUIStore();
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [shareOpen, setShareOpen] = useState(false);

  const typeCounts = contents.reduce<Record<string, number>>((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {});

  const tagCounts = contents.reduce<Record<string, number>>((acc, c) => {
    if (c.tags) for (const tag of c.tags) acc[tag] = (acc[tag] || 0) + 1;
    return acc;
  }, {});

  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  function handleLogout() {
    logout();
    navigate("/signin");
  }

  return (
    <div
      className={`fixed top-16 left-0 bottom-0 border-r border-white w-72 flex flex-col transition-transform duration-200 ${
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto pl-4 pr-2">
        <div className="pt-4">
          <SidebarContent
            text={`All (${contents.length})`}
            icon={<Globe size={20} />}
            active={activeFilter === null && activeTag === null}
            onClick={() => { setActiveFilter(null); setActiveTag(null); }}
          />
        </div>

        <div className="pt-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1">Types</p>
          {Object.entries(typeConfig).map(([type, config]) => {
            const count = typeCounts[type];
            if (!count) return null;
            return (
              <SidebarContent
                key={type}
                text={`${config.label} (${count})`}
                icon={config.icon}
                active={activeFilter === type}
                onClick={() => {
                  setActiveTag(null);
                  setActiveFilter(activeFilter === type ? null : (type as ContentType));
                }}
              />
            );
          })}
        </div>

        {sortedTags.length > 0 && (
          <div className="pt-4 pb-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-2 mb-1">Tags</p>
            {sortedTags.slice(0, 12).map(([tag, count]) => (
              <SidebarContent
                key={tag}
                text={`${tag} (${count})`}
                icon={<Hash size={20} />}
                active={activeTag === tag}
                onClick={() => {
                  setActiveFilter(null);
                  setActiveTag(activeTag === tag ? null : tag);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Share + Logout ── */}
      <div className="p-3 border-t border-white/10">
        <button
          onClick={() => setShareOpen(true)}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-gray-400 hover:text-white hover:bg-white/5 transition-all duration-150 mb-1"
        >
          <span className="shrink-0 [&_svg]:w-4 [&_svg]:h-4"><ShareIcon size="sm" /></span>
          <span className="text-sm font-medium">Share Recall</span>
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-all duration-150"
        >
          <LogOut size={16} className="shrink-0" />
          <span className="text-sm font-medium">Log out</span>
        </button>
      </div>

      <ShareBrainModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}
