// ─── Text Extractor ─────────────────────────────────────────────
// Extracts meaningful text from different content types.
// This text is used for:
// 1. Claude API summarization (Day 2)
// 2. Vector embeddings for semantic search (Day 3)
//
// The metadataFetcher (Day 1) already extracts article text via Readability.
// This service handles the platform-specific cases that Readability can't:
// - YouTube → video transcript (auto-generated captions)
// - Twitter → tweet text (from OG tags, already fetched)
// - GitHub  → README content
// - Reddit  → post text (from OG tags)
//
// For articles/links, the extractedText from metadataFetcher is used as-is.

import type { DetectedType } from "./linkDetector";

interface TextExtractionResult {
  text: string | null;
}

// ── YouTube transcript ──
// Uses the youtube-transcript package which scrapes YouTube's auto-generated
// captions. No API key needed — it works by fetching the same captions data
// that the YouTube player loads.
//
// If the video has no captions (rare for English content), this returns null.
async function extractYouTubeTranscript(videoId: string): Promise<string | null> {
  try {
    // Dynamic import — the package uses ESM
    const { YoutubeTranscript } = await import("youtube-transcript");
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    if (!transcript || transcript.length === 0) return null;

    // Combine all caption segments into one string.
    // Each segment is { text: "hello world", offset: 1000, duration: 3000 }.
    // We just want the text.
    const fullText = transcript.map((seg) => seg.text).join(" ");

    // Cap at 10K chars (same as articles) to control embedding cost
    return fullText.trim().slice(0, 10_000) || null;
  } catch (err) {
    console.error(`[textExtractor] YouTube transcript failed for ${videoId}:`, (err as Error).message);
    return null;
  }
}

// ── GitHub README ──
// Fetches the raw README.md from the default branch.
// raw.githubusercontent.com serves files without rate limits for reasonable use.
async function extractGitHubReadme(owner: string, repo: string): Promise<string | null> {
  // Try common README filenames in order
  const filenames = ["README.md", "readme.md", "README.rst", "README"];

  for (const filename of filenames) {
    try {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filename}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const text = await res.text();
        return text.trim().slice(0, 10_000) || null;
      }
    } catch {
      // Try next filename
    }
  }

  return null;
}

// ─── Main extraction function ───────────────────────────────────
// Called by the BullMQ worker with the content's type, link, and
// any text already extracted by metadataFetcher.

export async function extractText(
  type: DetectedType,
  link: string,
  existingText: string | null,
  embedData: { videoId?: string; owner?: string; repo?: string }
): Promise<TextExtractionResult> {
  // If Readability already extracted good text (articles, generic links),
  // use that. No need to re-fetch.
  if (existingText && existingText.length > 100) {
    return { text: existingText };
  }

  switch (type) {
    case "youtube": {
      if (!embedData.videoId) return { text: null };
      const transcript = await extractYouTubeTranscript(embedData.videoId);
      return { text: transcript };
    }

    case "github": {
      if (!embedData.owner || !embedData.repo) return { text: null };
      const readme = await extractGitHubReadme(embedData.owner, embedData.repo);
      return { text: readme };
    }

    case "twitter":
    case "reddit":
    case "instagram":
      // For social media, the OG description (already in ogDescription column)
      // is usually the post text. We'll combine it with any other extracted text.
      // The metadataFetcher already stored this, so we just use existingText
      // or fall back to null.
      return { text: existingText };

    default:
      return { text: existingText };
  }
}