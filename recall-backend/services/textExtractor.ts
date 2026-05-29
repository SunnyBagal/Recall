import type { DetectedType } from "./linkDetector";

interface TextExtractionResult {
  text: string | null;
}

async function extractYouTubeTranscript(videoId: string): Promise<string | null> {
  try {
    const { YoutubeTranscript } = await import("youtube-transcript");
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    if (!transcript || transcript.length === 0) return null;

    const fullText = transcript.map((seg) => seg.text).join(" ");
    return fullText.trim().slice(0, 10_000) || null;
  } catch (err) {
    console.error(`[textExtractor] YouTube transcript failed for ${videoId}:`, (err as Error).message);
    return null;
  }
}

async function extractGitHubReadme(owner: string, repo: string): Promise<string | null> {
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
    }
  }

  return null;
}

export async function extractText(
  type: DetectedType,
  link: string,
  existingText: string | null,
  embedData: { videoId?: string; owner?: string; repo?: string }
): Promise<TextExtractionResult> {
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
      return { text: existingText };

    default:
      return { text: existingText };
  }
}
