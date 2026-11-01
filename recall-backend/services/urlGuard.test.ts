import { describe, expect, test } from "bun:test";
import { isPrivateAddress, isPublicHttpUrl } from "./urlGuard";
import { fetchMetadata } from "./metadataFetcher";

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111"])(
    "%s is public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("isPublicHttpUrl", () => {
  test.each([
    "file:///etc/passwd",
    "ftp://93.184.215.14/",
    "javascript:alert(1)",
    "http://127.0.0.1:3000/",
    "http://2130706433/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://localhost:6379/",
    "not a url",
  ])("rejects %s", async (url) => {
    expect(await isPublicHttpUrl(url)).toBe(false);
  });

  test("accepts a public IP literal", async () => {
    expect(await isPublicHttpUrl("https://93.184.215.14/page")).toBe(true);
  });
});

describe("fetchMetadata", () => {
  test("does not read loopback-only servers", async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits++;
        return new Response(
          `<html><head><title>t</title><meta property="og:title" content="og"></head><body><article><p>${"text ".repeat(100)}</p></article></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    try {
      for (const url of [`http://127.0.0.1:${server.port}/a`, `http://localhost:${server.port}/a`]) {
        const result = await fetchMetadata(url, "link");
        expect(result.blocked).toBe(true);
        expect(result.extractedText).toBeNull();
        expect(result.ogDescription).toBeNull();
      }
      expect(hits).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
