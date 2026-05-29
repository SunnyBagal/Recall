
export type DetectedType = 
  | "youtube" 
  | "twitter"
  | "reddit" 
  | "github"
  | "instagram" 
  | "article"
  | "link";


export interface LinkDetectionResult {
  type: DetectedType;

  embedData: {
    videoId?: string;
    tweetId?: string;
    subreddit?: string;
    postId?: string;
    owner?: string;
    repo?: string;
  };

  embedUrl: string | null;

}


function detectYoutube (url: URL) : LinkDetectionResult | null {
  let videoId: string | null = null;

  if (url.hostname.includes("youtube")) {
    videoId = url.searchParams.get("v");

    if (!videoId) {
      const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) videoId = embedMatch[1] ?? null;
    }

    if (!videoId){
      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) videoId = shortsMatch[1] ?? null;
    }
  } else if (url.hostname === "youtu.be"){
    videoId = url.pathname.slice(1) || null;
  }

  if (!videoId) return null;

  return {
    type: "youtube",
    embedData: {videoId},
    embedUrl: `https://www.youtube.com/embed/${videoId}`
  };
}




function detectTwitter(url: URL): LinkDetectionResult | null {
  if (!url.hostname.includes("twitter.com") && !url.hostname.includes("x.com")) {
    return null;
  }
 
  const match = url.pathname.match(/\/\w+\/status\/(\d+)/);
  if (!match) return null;
 
  return {
    type: "twitter",
    embedData: { tweetId: match[1] },
    embedUrl: null,
  };
}


function detectReddit(url: URL): LinkDetectionResult | null {
  if (!url.hostname.includes("reddit.com")) return null;

  const match = url.pathname.match(/\/r\/([^/]+)\/comments\/([^/]+)/);
  if (!match){
    return null;
  }

  return {
    type: "reddit",
    embedData: { subreddit: match[1], postId: match[2] },
    embedUrl: `https://www.reddit.com${url.pathname}?ref=share&ref_source=embed`,
  };
}



function detectGitHub(url: URL) : LinkDetectionResult | null {
  if (url.hostname !== "github.com") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo] = parts;
  if (!owner || !repo) return null;

  const nonRepoPaths = ["settings", "notifications", "explore", "topics", "trending", "marketplace"];
  if (nonRepoPaths.includes(owner)) return null;

  return {
    type: "github",
    embedData: { owner, repo },
    embedUrl: null
  };
}





function detectInstagram(url: URL): LinkDetectionResult | null {
  if (!url.hostname.includes("instagram.com")) return null;

  const match = url.pathname.match(/\/(p|reel)\/([^/]+)/);
  if (!match) return null;

  return {
    type: "instagram",
    embedData: { postId: match[2] },
    embedUrl: `https://www.instagram.com/${match[1]}/${match[2]}/embed`
  };
}




function detectArticle(url: URL): boolean {

  const articleDomains = [
    "medium.com",
    "dev.to",
    "hashnode.com",
    "substack.com",
    "geeksforgeeks.org",
    "stackoverflow.com",
    "freecodecamp.org",
    "hackernoon.com",
    "techcrunch.com",
    "arstechnica.com",
    "nytimes.com",
    "wired.com",
    "notion.site",
    "docs.google.com",
    "wikipedia.org",
  ];

  const hostname = url.hostname.replace("www.","");

  if (articleDomains.some((d) => hostname.includes(d))) return true;

  const pathSegments = url.pathname.split("/").filter(Boolean);

  if (pathSegments.length >= 2) {
    const hasSlug = pathSegments.some((s) => s.includes("-") && s.length > 10);
    if (hasSlug) {
      return true
    }
  }
  return false
}



export function detectLinkType(rawUrl: string) : LinkDetectionResult {
  let url : URL;

  try {
    const normalised = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;

    url = new URL(normalised);

  } catch(err){

    return { 
      type: "link", 
      embedData: {}, 
      embedUrl: null
    }

  }

  const youtube = detectYoutube(url);
  if (youtube) return youtube;

  const twitter = detectTwitter(url);
  if (twitter) return twitter;
 
  const reddit = detectReddit(url);
  if (reddit) return reddit;
 
  const github = detectGitHub(url);
  if (github) return github;
 
  const instagram = detectInstagram(url);
  if (instagram) return instagram;


  if (detectArticle(url)) {
    return { type: "article", embedData: {}, embedUrl: null };
  }
 
  return { type: "link", embedData: {}, embedUrl: null };
 

}
