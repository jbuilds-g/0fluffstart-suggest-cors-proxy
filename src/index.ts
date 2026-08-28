/**
 * Cloudflare Worker: Search Suggestions Proxy
 *
 * Handles client requests for autosuggest/search completions from various
 * upstream search providers (Google, Bing, DuckDuckGo, Brave), enforcing CORS,
 * auth checks, and KV-backed rate limiting.
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Environment bindings injected into the Cloudflare Worker runtime.
 */
export interface Env {
  /** Optional secret token used to authenticate incoming request headers. */
  AUTH_SECRET: string;
  /** KV namespace instance used for IP-based rate limiting. */
  RATE_LIMIT_KV: KVNamespace;
}

// ============================================================================
// Constants & Configuration
// ============================================================================

/** Maximum allowed requests per minute per IP address. */
const MAX_REQUESTS_PER_MIN = 40;

/** Default User-Agent string sent to upstream search providers to prevent blocking. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

/**
 * Mapping of supported engine identifiers to their corresponding suggestion API endpoints.
 */
const SEARCH_ENGINES: Record<string, (query: string) => string> = {
  google: (q) =>
    `https://suggestqueries.google.com/complete/search?client=chrome&q=${q}`,
  bing: (q) => `https://api.bing.com/osjson.aspx?query=${q}`,
  duckduckgo: (q) => `https://duckduckgo.com/ac/?q=${q}&type=list`,
  brave: (q) => `https://search.brave.com/api/suggest?q=${q}`,
};

// ============================================================================
// Helper Utilities
// ============================================================================

/**
 * Determines whether the requesting IP has exceeded the allowed request rate.
 * Uses a fixed 1-minute window backed by Cloudflare KV.
 *
 * @param clientIp The client's IP address (typically from `CF-Connecting-IP`).
 * @param kv The KV namespace used for tracking request counts.
 * @returns Resolves to `true` if the IP is rate-limited, otherwise `false`.
 */
async function isRateLimitedKV(
  clientIp: string,
  kv: KVNamespace,
): Promise<boolean> {
  if (!kv) return false;

  const windowKey = `rl:${clientIp}:${Math.floor(Date.now() / 60000)}`;
  const current = await kv.get(windowKey);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= MAX_REQUESTS_PER_MIN) {
    return true;
  }

  await kv.put(windowKey, (count + 1).toString(), { expirationTtl: 120 });
  return false;
}

/**
 * Validates and extracts the allowed origin header from incoming HTTP request.
 * Allows specific allowed domains, browser extension origins, and local environments.
 *
 * @param request The incoming HTTP Request object.
 * @returns The allowed origin string or `null` if forbidden.
 */
function getAllowedOrigin(request: Request): string | null {
  const origin =
    request.headers.get("Origin") || request.headers.get("Referer");

  if (!origin) return "*";

  if (
    origin === "https://jbuilds-g.github.io" ||
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1")
  ) {
    return origin.startsWith("chrome-extension://") ||
      origin.startsWith("moz-extension://")
      ? new URL(origin).origin
      : origin;
  }

  return "*";
}

/**
 * Creates a standard Response object pre-configured with required CORS headers.
 *
 * @param body The payload body to attach to the response.
 * @param options Additional response initialization settings (status, headers).
 * @param allowedOrigin The validated origin header string.
 * @returns A Response object containing the appended CORS headers.
 */
function createCORSResponse(
  body: BodyInit | null,
  options: ResponseInit,
  allowedOrigin: string,
): Response {
  const headers = new Headers(options.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");

  return new Response(body, { ...options, headers });
}

// ============================================================================
// Main Fetch Handler
// ============================================================================

export default {
  /**
   * Main entry point for Cloudflare Worker fetch events.
   *
   * Handles CORS preflight requests, authorization tokens, rate limiting,
   * parameter validation, and proxying requests to upstream search endpoints.
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const allowedOrigin = getAllowedOrigin(request);

    // Handle OPTIONS Preflight Requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":
            allowedOrigin || "https://jbuilds-g.github.io",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Origin Check
    if (!allowedOrigin) {
      return new Response(JSON.stringify({ error: "Forbidden Origin" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Bearer Token Authorization Check
    if (env.AUTH_SECRET) {
      const authHeader = request.headers.get("Authorization");
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

      if (!token || token !== env.AUTH_SECRET) {
        return createCORSResponse(
          JSON.stringify({ error: "Unauthorized access" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
          allowedOrigin,
        );
      }
    }

    // Rate Limit Verification
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await isRateLimitedKV(clientIp, env.RATE_LIMIT_KV)) {
      return createCORSResponse(
        JSON.stringify({ error: "Too Many Requests" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Retry-After": "60",
          },
        },
        allowedOrigin,
      );
    }

    // HTTP Method Validation
    if (request.method !== "GET") {
      return createCORSResponse(
        JSON.stringify({ error: "Method Not Allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json" },
        },
        allowedOrigin,
      );
    }

    // Query Parameter Parsing & Validation
    const url = new URL(request.url);
    const engineKey = url.searchParams.get("engine")?.toLowerCase();
    const query = url.searchParams.get("q");

    if (!engineKey || !query || !(engineKey in SEARCH_ENGINES)) {
      return createCORSResponse(
        JSON.stringify({
          error: 'Invalid request parameters. Specify valid "engine" and "q".',
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        },
        allowedOrigin,
      );
    }

    // Upstream Execution
    const upstreamUrl = SEARCH_ENGINES[engineKey](encodeURIComponent(query));

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "GET",
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!upstreamResponse.ok) {
        return createCORSResponse(
          JSON.stringify({
            error: "Upstream search engine returned an error",
            upstreamStatus: upstreamResponse.status,
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            },
          },
          allowedOrigin,
        );
      }

      const responseData = await upstreamResponse.text();

      return createCORSResponse(
        responseData,
        {
          status: 200,
          headers: {
            "Content-Type":
              upstreamResponse.headers.get("Content-Type") ||
              "application/json",
            "Cache-Control": "private, max-age=300, stale-while-revalidate=60",
            "Cloudflare-CDN-Cache-Control": "max-age=300",
          },
        },
        allowedOrigin,
      );
    } catch {
      return createCORSResponse(
        JSON.stringify({
          error: "Failed to connect to upstream search engine",
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          },
        },
        allowedOrigin,
      );
    }
  },
};
