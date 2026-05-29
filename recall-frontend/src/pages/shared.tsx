import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { BACKEND_URL } from "../config";
import Card from "../components/Card";
import { LogoIcon } from "../icons/LogoIcon";
import type { Content } from "../hooks/useContent";

interface SharedData {
  username: string;
  content: Content[];
}

export default function SharedBrain() {
  const { hash } = useParams<{ hash: string }>();
  const [data, setData] = useState<SharedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!hash) return;
    axios
      .get(`${BACKEND_URL}/api/v1/brain/${hash}`)
      .then((res) => setData(res.data))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [hash]);

  if (loading) {
    return (
      <div className="min-h-screen bg-mybackg flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-mybackg flex flex-col items-center justify-center gap-2 text-center px-4">
        <p className="text-white font-semibold text-xl">This link doesn't exist</p>
        <p className="text-gray-500 text-sm">The share link may have been removed or never created.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mybackg">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 h-16 flex items-center gap-3 px-8 border-b border-white/10 bg-mybackg z-10">
        <LogoIcon size="lg" />
        <span className="text-white font-semibold text-xl">
          {data?.username}'s Recall
        </span>
      </header>

      {/* Card grid */}
      <div className="pt-20 px-6 pb-6">
        <div className="@container">
          {(data?.content ?? []).length === 0 ? (
            <div className="flex items-center justify-center min-h-[50vh] text-gray-500 text-sm">
              Nothing saved yet.
            </div>
          ) : (
            <div className="columns-1 @[640px]:columns-2 @[960px]:columns-3 @[1280px]:columns-4 gap-4 [column-fill:balance]">
              {(data?.content ?? []).map((item) => (
                <div key={item.id} className="mb-4 break-inside-avoid">
                  <Card
                    id={item.id}
                    title={item.title}
                    type={item.type}
                    link={item.link}
                    favicon={item.favicon}
                    embedUrl={item.embedUrl}
                    ogTitle={item.ogTitle}
                    ogDescription={item.ogDescription}
                    ogImage={item.ogImage}
                    ogSiteName={item.ogSiteName}
                    summary={item.summary}
                    tags={item.tags}
                    processingStatus={item.processingStatus}
                    readOnly
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
