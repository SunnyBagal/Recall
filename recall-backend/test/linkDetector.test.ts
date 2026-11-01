// Characterization tests: these assert what detectLinkType returns today,
// oddities included — not what it should return.
import { describe, expect, test } from "bun:test";
import { detectLinkType, type LinkDetectionResult } from "../services/linkDetector";

const plain = (type: "article" | "link"): LinkDetectionResult => ({ type, embedData: {}, embedUrl: null });

describe("detectLinkType", () => {
  test("youtube: watch, short, embed and shorts URLs", () => {
    const expected: LinkDetectionResult = {
      type: "youtube",
      embedData: { videoId: "dQw4w9WgXcQ" },
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    };

    expect(detectLinkType("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s")).toEqual(expected);
    expect(detectLinkType("https://youtu.be/dQw4w9WgXcQ?si=abc")).toEqual(expected);
    expect(detectLinkType("https://www.youtube.com/embed/dQw4w9WgXcQ")).toEqual(expected);
    expect(detectLinkType("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toEqual(expected);
  });

  test("youtube: a channel page has no video id and falls through to link", () => {
    expect(detectLinkType("https://www.youtube.com/@somechannel")).toEqual(plain("link"));
  });

  test("twitter and x.com status URLs", () => {
    const expected: LinkDetectionResult = { type: "twitter", embedData: { tweetId: "1234567890" }, embedUrl: null };

    expect(detectLinkType("https://twitter.com/jack/status/1234567890")).toEqual(expected);
    expect(detectLinkType("https://x.com/jack/status/1234567890?s=20")).toEqual(expected);
    expect(detectLinkType("https://x.com/jack")).toEqual(plain("link"));
  });

  test("reddit comment threads", () => {
    expect(
      detectLinkType("https://www.reddit.com/r/programming/comments/abc123/some_title/"),
    ).toEqual({
      type: "reddit",
      embedData: { subreddit: "programming", postId: "abc123" },
      embedUrl:
        "https://www.reddit.com/r/programming/comments/abc123/some_title/?ref=share&ref_source=embed",
    });
    expect(detectLinkType("https://www.reddit.com/r/programming/")).toEqual(plain("link"));
  });

  test("github repos, including deeper paths; reserved first segments are not repos", () => {
    const expected: LinkDetectionResult = { type: "github", embedData: { owner: "oven-sh", repo: "bun" }, embedUrl: null };

    expect(detectLinkType("https://github.com/oven-sh/bun")).toEqual(expected);
    expect(detectLinkType("https://github.com/oven-sh/bun/issues/1")).toEqual(expected);
    expect(detectLinkType("https://github.com/oven-sh")).toEqual(plain("link"));
    expect(detectLinkType("https://github.com/settings/profile")).toEqual(plain("link"));
    // only the bare host matches
    expect(detectLinkType("https://www.github.com/oven-sh/bun")).toEqual(plain("link"));
  });

  test("instagram posts and reels", () => {
    expect(detectLinkType("https://www.instagram.com/p/Cabc123/")).toEqual({
      type: "instagram",
      embedData: { postId: "Cabc123" },
      embedUrl: "https://www.instagram.com/p/Cabc123/embed",
    });
    expect(detectLinkType("https://www.instagram.com/reel/Cxyz789/")).toEqual({
      type: "instagram",
      embedData: { postId: "Cxyz789" },
      embedUrl: "https://www.instagram.com/reel/Cxyz789/embed",
    });
  });

  test("articles: known domains, or a long hyphenated slug at depth 2+", () => {
    expect(detectLinkType("https://medium.com/")).toEqual(plain("article"));
    expect(detectLinkType("https://en.wikipedia.org/wiki/Rust")).toEqual(plain("article"));
    expect(detectLinkType("https://blog.example.com/posts/why-rust-is-fast")).toEqual(plain("article"));
    // a slug at depth 1 is not enough
    expect(detectLinkType("https://blog.example.com/why-rust-is-fast")).toEqual(plain("link"));
    expect(detectLinkType("https://example.com/")).toEqual(plain("link"));
  });

  test("input without a scheme gets https://; unparseable input is a link", () => {
    expect(detectLinkType("github.com/oven-sh/bun").type).toBe("github");
    expect(detectLinkType("not a url")).toEqual(plain("link"));
    expect(detectLinkType("")).toEqual(plain("link"));
  });

  test("oddity: hosts are matched by substring, so look-alike domains are misdetected", () => {
    // "netflix.com" contains "x.com"
    expect(detectLinkType("https://netflix.com/someone/status/42")).toEqual({
      type: "twitter",
      embedData: { tweetId: "42" },
      embedUrl: null,
    });
    // any host containing "youtube" with a ?v= parameter
    expect(detectLinkType("https://notyoutube.example/watch?v=abc")).toEqual({
      type: "youtube",
      embedData: { videoId: "abc" },
      embedUrl: "https://www.youtube.com/embed/abc",
    });
  });

  test("oddity: a host that merely starts with 'http' gets no scheme added and is a link", () => {
    expect(detectLinkType("httpbin.org/posts/some-long-article-slug")).toEqual(plain("link"));
  });
});
