import { useEffect, useState } from "react";
import { SparkleIcon } from "../icons/SparkleIcon";
import { TwitterIcon } from "../icons/TwitterIcon";
import { YoutubeIcon } from "../icons/YoutubeIcon";
import { InstagramIcon } from "../icons/InstagramIcon";
import { GithubIcon } from "../icons/GithubIcon";
import { RedditIcon } from "../icons/RedditIcon";
import { Trash2, ExternalLink, Globe, FileText } from "lucide-react";
import { useDeleteContent, type ContentType } from "../hooks/useContent";

declare global {
  interface Window {
    twttr?: { widgets: { load: (el?: HTMLElement) => void } };
  }
}

const typeIcons: Record<ContentType, React.ReactNode> = {
  youtube:   <YoutubeIcon />,
  twitter:   <TwitterIcon />,
  reddit:    <RedditIcon />,
  github:    <GithubIcon />,
  instagram: <InstagramIcon />,
  article:   <FileText size={16} />,
  link:      <Globe size={16} />,
};

export interface CardProps {
  id: string;
  title: string | null;
  link: string;
  type: ContentType;
  favicon?: string | null;
  embedUrl?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: string | null;
  ogSiteName?: string | null;
  summary?: string | null;
  tags?: string[] | null;
  processingStatus?: string;
  onAskAI?: () => void;
  readOnly?: boolean;
}

function SiteLogo({ favicon, type }: { favicon?: string | null; type: ContentType }) {
  const [imgFailed, setImgFailed] = useState(false);

  if (favicon && !imgFailed) {
    return (
      <img
        src={favicon}
        alt=""
        className="w-4 h-4 rounded-sm object-contain"
        loading="lazy"
        onError={() => setImgFailed(true)}
      />
    );
  }

  
  return <span className="text-gray-400 [&_svg]:w-4 [&_svg]:h-4">{typeIcons[type] ?? <Globe size={16} />}</span>;
}

export function Card({
  id, title, link, type, favicon, embedUrl, ogTitle, ogDescription,
  ogImage, ogSiteName, summary, tags, processingStatus, onAskAI, readOnly,
}: CardProps) {
  const deleteContent = useDeleteContent();

  useEffect(() => {
    if (type === "twitter") window.twttr?.widgets.load();
  }, [type, link]);

  const displayTitle = title || ogTitle || link;

  return (
    <div className="p-5 border bg-mycolor rounded-md shadow-md border-gray-100 w-full min-h-72 flex flex-col group">
      
      <div className="flex items-start gap-2">
        <div className="pt-0.5 shrink-0">
          <SiteLogo favicon={favicon} type={type} />
        </div>
        <p className="flex-1 min-w-0 text-sm font-medium truncate">{displayTitle}</p>
        
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="p-1 text-gray-400 hover:text-gray-700 rounded transition-colors"
            title="Open link"
          >
            <ExternalLink size={14} />
          </a>
          {!readOnly && onAskAI && (
            <button
              type="button"
              onClick={onAskAI}
              className="p-1 text-gray-400 hover:text-gray-700 rounded transition-colors"
              title="Ask AI"
            >
              <SparkleIcon size="sm" />
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={() => deleteContent.mutate(id)}
              className="p-1 text-gray-400 hover:text-red-500 rounded transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      
      <div className="pt-3 flex-1">
        {type === "youtube" && (
          <iframe
            className="w-full aspect-video rounded-md"
            src={embedUrl ?? link.replace("watch", "embed")}
            title="YouTube video player"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        )}

        {type === "twitter" && (
          <blockquote className="twitter-tweet">
            <a href={link.replace("x.com", "twitter.com")}></a>
          </blockquote>
        )}

        {type !== "youtube" && type !== "twitter" && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md overflow-hidden border border-gray-200 hover:border-gray-400 transition-colors"
          >
            {ogImage && (
              <img src={ogImage} alt={ogTitle ?? ""} className="w-full h-40 object-cover" loading="lazy" />
            )}
            <div className="p-3">
              {ogSiteName && <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">{ogSiteName}</p>}
              {ogTitle && <p className="text-sm font-medium text-gray-800 line-clamp-2">{ogTitle}</p>}
              {ogDescription && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{ogDescription}</p>}
              {!ogTitle && !ogDescription && <p className="text-sm text-gray-500 truncate">{link}</p>}
            </div>
          </a>
        )}
      </div>

      
      {processingStatus === "pending" || processingStatus === "processing" ? (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <div className="h-3 bg-gray-200 rounded animate-pulse w-3/4 mb-1.5" />
          <div className="h-3 bg-gray-200 rounded animate-pulse w-1/2" />
        </div>
      ) : summary ? (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <p className="text-xs text-gray-500 line-clamp-3">{summary}</p>
        </div>
      ) : null}

      
      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {tags.map((tag) => (
            <span key={tag} className="px-2 py-0.5 text-[10px] bg-gray-100 text-gray-500 rounded-full">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default Card;
