import type { ReactElement } from "react";

type SidebarContentProp = {
  text: string;
  icon: ReactElement;
  active?: boolean;
  onClick?: () => void;
};

export function SidebarContent({ text, icon, active, onClick }: SidebarContentProp) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 p-2 w-full text-left py-2 cursor-pointer rounded-lg max-w-56 transition-all duration-150
        ${active
          ? "bg-gray-200 text-black font-medium"
          : "text-gray-300 hover:bg-white/5"
        }`}
    >
      <div className="shrink-0 [&_svg]:w-5 [&_svg]:h-5">{icon}</div>
      <div className="truncate text-sm">{text}</div>
    </button>
  );
}
