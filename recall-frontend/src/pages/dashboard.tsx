import { Sidebar } from "../components/Sidebar";
import { CreateContentModel } from "../components/CreateContent";
import Button from "../components/Button";
import Card from "../components/Card";
import { PlusIcon } from "../icons/PlusIcon";
import { SparkleIcon } from "../icons/SparkleIcon";
import { LogoIcon } from "../icons/LogoIcon";
import { InputBar } from "../components/InputBar";
import { AskAIPanel } from "../components/AskAIPanel";
import { useContent } from "../hooks/useContent";
import { useSearch } from "../hooks/useSearch";
import { useUIStore } from "../stores/uiStore";
import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Search, Hash } from "lucide-react";

function Dashboard() {
  const { contents, isLoading } = useContent();
  const {
    aiPanelOpen, aiPanelWidth, activeCard, toggleAiPanel, closeAiPanel,
    askAboutCard, clearActiveCard, activeFilter, activeTag,
    sidebarOpen, toggleSidebar, searchQuery, clearSearch,
  } = useUIStore();

  const { results: searchResults, isSearching } = useSearch(searchQuery);

  const [modalOpen, setModalOpen] = useState(false);

  // Priority: search → tag filter → type filter → all
  const isSearchActive = searchQuery.trim().length > 0;
  const displayContents = isSearchActive
    ? searchResults
    : activeTag
      ? contents.filter((c) => c.tags?.includes(activeTag))
      : activeFilter
        ? contents.filter((c) => c.type === activeFilter)
        : contents;

  return (
    <>
      {/* ── Navbar (user's exact code preserved) ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b h-16 flex items-center justify-between bg-mybackg border-white">
        <div className={`flex items-center h-full px-6 shrink-0 border-r border-white transition-all duration-200 w-72 justify-center`}>
          <div className="flex items-center gap-2 text-4xl font-semibold text-white">
            <LogoIcon  size="lg" />
           Recall
          </div>
        </div>

        <div className="border-r border-white h-full flex items-center justify-center w-20">
           <button
            onClick={toggleSidebar}
            className="rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            {sidebarOpen ? <PanelLeftClose size={24} /> : <PanelLeftOpen size={24} />}
          </button>
        </div>

        <div className="flex-1 min-w-0 px-6">
          <InputBar />
        </div>

        <div className="flex items-center h-full">
          <div className="border-l border-white h-full" />
          <div className="flex items-center justify-center h-full px-4">
            <Button
              startIcon={<PlusIcon size="md" />}
              variant="secondary" size="md"
              onClick={() => setModalOpen(true)}
              text="Add content"
            />
          </div>
          <div className="border-l border-white h-full" />
          <div className="flex items-center justify-center h-full px-4">
            <Button
              startIcon={<SparkleIcon size="md" />}
              variant={aiPanelOpen ? "primary" : "secondary"} size="md"
              onClick={toggleAiPanel}
              text="Ask AI"
            />
          </div>
        </div>
      </nav>

      <Sidebar />

      <AskAIPanel
        open={aiPanelOpen}
        onClose={closeAiPanel}
        context={activeCard}
        onClearContext={clearActiveCard}
      />

      <div
        style={{ marginRight: aiPanelOpen ? aiPanelWidth : 0 }}
        className={`pt-16 transition-[margin] duration-200 ${sidebarOpen ? "ml-72" : "ml-0"}`}
      >
        <CreateContentModel
          open={modalOpen}
          onClose={() => setModalOpen(false)}
        />

        {isSearchActive && (
          <div className="px-4 pt-4 pb-0 flex items-center gap-2 text-gray-400">
            <Search size={16} />
            <span className="text-sm">
              {isSearching ? `Searching for "${searchQuery}"...` : `${searchResults.length} results for "${searchQuery}"`}
            </span>
            <button onClick={clearSearch} className="text-xs ml-2 underline hover:text-gray-600 transition-colors">Clear</button>
          </div>
        )}

        {activeTag && !isSearchActive && (
          <div className="px-4 pt-4 pb-0 flex items-center gap-2 text-gray-400">
            <Hash size={16} />
            <span className="text-sm">Filtered by tag: <span className="text-white font-medium">{activeTag}</span></span>
          </div>
        )}

        <div className="@container p-4">
          {(isLoading || isSearching) ? (
            <div className="columns-1 @[640px]:columns-2 @[960px]:columns-3 @[1280px]:columns-4 gap-4">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="mb-4 break-inside-avoid">
                  <div className="p-6 border rounded-md shadow-md border-gray-100 min-h-72 animate-pulse bg-gray-100" />
                </div>
              ))}
            </div>
          ) : displayContents.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-gray-400">
              <p className="text-lg">
                {isSearchActive ? `No results for "${searchQuery}"` : activeTag ? `No content tagged "${activeTag}"` : activeFilter ? `No ${activeFilter} content yet` : "No content yet"}
              </p>
              <p className="text-sm mt-1">
                {isSearchActive ? "Try a different search term or paste a new URL." : "Paste a URL in the search bar or click \"Add content\" to get started."}
              </p>
            </div>
          ) : (
            <div className="columns-1 @[640px]:columns-2 @[960px]:columns-3 @[1280px]:columns-4 @[1600px]:columns-5 gap-4 [column-fill:balance]">
              {displayContents.map((item) => (
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
                    onAskAI={() => askAboutCard(item)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default Dashboard;