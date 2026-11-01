import { contents } from "./schema";

// Fields the public shared page renders (recall-frontend/src/pages/shared.tsx → Card).
export const sharedContentColumns = {
  id: contents.id,
  title: contents.title,
  link: contents.link,
  type: contents.type,
  favicon: contents.favicon,
  embedUrl: contents.embedUrl,
  ogTitle: contents.ogTitle,
  ogDescription: contents.ogDescription,
  ogImage: contents.ogImage,
  ogSiteName: contents.ogSiteName,
  summary: contents.summary,
  tags: contents.tags,
  processingStatus: contents.processingStatus,
};
