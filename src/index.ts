/**
 * Cloudflare Worker: Search Suggestions Proxy
 *
 * Public browser-facing proxy for autosuggest/search completions from Google,
 * Bing, DuckDuckGo, and Brave. The Worker does not intentionally log requests
 * or forward client IP metadata to upstream providers.
 */

export interface Env {
  RATE_LIMIT_KV: KVNamespace;
}

const MAX_REQUESTS_PER_MIN = 40;
const MAX_QUERY_LENGTH = 200;
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 5000;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const SEARCH_ENGINES: Record<string, (query: string) => string> = {
  google: (q) =>
    `https://suggestqueries.google.com/complete/search?client=chrome&q=${q}`,
  bing: (q) => `https://api.bing.com/osjson.aspx?query=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/ac/?q=${q}&type=list`,
  brave: (q) => `https://search.brave.com/api/suggest?q=${q}`,
};

function getAllowedOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  try {
    const parsed = new URL(origin);

    if (parsed.origin === "https://0fluffstart.pages.dev") {
      return parsed.origin;
    }

    if (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
    ) {
      return parsed.origin;
    }

    if (
      (parsed.protocol === "chrome-extension:" ||
        parsed.protocol === "moz-extension:") &&
      parsed.hostname
    ) {
      return parsed.origin;
    }
  } catch {
    return null;
  }

  return null;
}

function createResponse(
  body: BodyInit | null,
  options: ResponseInit,
  allowedOrigin: string | null,
): Response {
  const headers = new Headers(options.headers);

  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Vary", "Origin");
  }

  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { ...options, headers });
}

function createCorsResponse(
  body: BodyInit | null,
  options: ResponseInit,
  allowedOrigin: string,
): Response {
  const headers = new Headers(options.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(body, { ...options, headers });
}

async function isRateLimitedKV(
  clientIp: string,
  kv: KVNamespace,
): Promise<boolean> {
  if (!kv) return false;

  const windowKey = `rl:${clientIp}:${Math.floor(Date.now() / 60000)}`;

  try {
    const current = await kv.get(windowKey);
    const count = current ? Number.parseInt(current, 10) : 0;

    if (!Number.isFinite(count) || count >= MAX_REQUESTS_PER_MIN) {
      return count >= MAX_REQUESTS_PER_MIN;
    }

    await kv.put(windowKey, String(count + 1), { expirationTtl: 120 });
  } catch {
    // KV is best-effort protection. A KV failure must not take down the public API.
  }

  return false;
}

async function readUpstreamBody(response: Response): Promise<string | null> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > MAX_UPSTREAM_RESPONSE_BYTES) {
    return null;
  }

  if (!response.body) {
    const text = await response.text();
    return text.length <= MAX_UPSTREAM_RESPONSE_BYTES ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }

      result += decoder.decode(value, { stream: true });
    }

    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigin = getAllowedOrigin(request);

    if (request.method === "OPTIONS") {
      if (!allowedOrigin) {
        return createResponse(
          JSON.stringify({ error: "Forbidden Origin" }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
          null,
        );
      }

      return createCorsResponse(null, { status: 204 }, allowedOrigin);
    }

    const requestOrigin = request.headers.get("Origin");
    if (requestOrigin && !allowedOrigin) {
      return createResponse(
        JSON.stringify({ error: "Forbidden Origin" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
        null,
      );
    }

    if (request.method !== "GET") {
      return createResponse(
        JSON.stringify({ error: "Method Not Allowed" }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json",
            Allow: "GET, OPTIONS",
          },
        },
        allowedOrigin,
      );
    }

    const url = new URL(request.url);
    const pathEngine = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const engineKey = Object.hasOwn(SEARCH_ENGINES, pathEngine)
      ? pathEngine
      : url.searchParams.get("engine")?.trim().toLowerCase() ?? "";
    const query = url.searchParams.get("q")?.trim() ?? "";

    if (
      !engineKey ||
      !Object.hasOwn(SEARCH_ENGINES, engineKey) ||
      !query ||
      query.length > MAX_QUERY_LENGTH
    ) {
      return createResponse(
        JSON.stringify({
          error: `Invalid request. Use a supported engine and a query up to ${MAX_QUERY_LENGTH} characters.`,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
        allowedOrigin,
      );
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await isRateLimitedKV(clientIp, env.RATE_LIMIT_KV)) {
      return createResponse(
        JSON.stringify({ error: "Too Many Requests" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Retry-After": "60",
          },
        },
        allowedOrigin,
      );
    }

    const upstreamUrl = SEARCH_ENGINES[engineKey](encodeURIComponent(query));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "GET",
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });

      if (!upstreamResponse.ok) {
        return createResponse(
          JSON.stringify({ error: "Upstream search engine returned an error" }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
          allowedOrigin,
        );
      }

      const contentType = upstreamResponse.headers.get("Content-Type") || "";
      if (
        contentType &&
        !contentType.toLowerCase().startsWith("application/json") &&
        !contentType.toLowerCase().startsWith("text/javascript") &&
        !contentType.toLowerCase().startsWith("text/plain")
      ) {
        return createResponse(
          JSON.stringify({ error: "Unsupported upstream response type" }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
          allowedOrigin,
        );
      }

      const responseData = await readUpstreamBody(upstreamResponse);
      if (responseData === null) {
        return createResponse(
          JSON.stringify({ error: "Upstream response is too large" }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
          allowedOrigin,
        );
      }

      return createResponse(
        responseData,
        {
          status: 200,
          headers: {
            "Content-Type": contentType || "application/json",
            "Cache-Control": "private, max-age=60",
          },
        },
        allowedOrigin,
      );
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "Upstream request timed out"
          : "Failed to connect to upstream search engine";

      return createResponse(
        JSON.stringify({ error: message }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
        allowedOrigin,
      );
    } finally {
      clearTimeout(timeout);
    }
  },
};
