// fetch control for tests. Loopback requests (the test's own Express server)
// always go to the real fetch; everything else goes to the guard or a stub.

const realFetch = globalThis.fetch;

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

function isLoopback(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

const guardedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = urlOf(input);
  if (isLoopback(url)) return realFetch(input, init);
  throw new Error(`network is off in tests — unstubbed fetch to ${url}`);
}) as typeof fetch;

export function installFetchGuard() {
  globalThis.fetch = guardedFetch;
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Route every non-loopback fetch to `handler` and record the calls. Undo with
 * restoreFetch() (usually in afterEach).
 */
export function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    if (isLoopback(url)) return realFetch(input, init);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

export function restoreFetch() {
  installFetchGuard();
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
