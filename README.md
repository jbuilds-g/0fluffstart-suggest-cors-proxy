# 0fluffstart-suggest-cors-proxy

A lightweight, public CORS proxy built for Cloudflare Workers. Designed specifically for 0FluffStart to fetch real-time search suggestions without exposing client IP addresses or keypress metadata to upstream search engines.

## Features

- **Public browser API:** No client-side secret or bearer token is required.
- **Privacy-First:** Does not intentionally forward client IP metadata or log request data in the Worker.
- **Multi-Engine Support:** Proxies autocomplete endpoints for Google, Bing, DuckDuckGo, and Brave.
- **Edge Performance:** Runs on Cloudflare's global network.
- **Abuse Protection:** KV-backed per-IP rate limiting with a 40-request/minute target.
- **Request Hardening:** Query length limits, upstream timeouts, response-size limits, and restricted CORS origins.

## API

Each provider can be addressed directly by path:

- Google: `/google?q=query`
- Bing: `/bing?q=query`
- DuckDuckGo: `/duckduckgo?q=query`
- Brave: `/brave?q=query`

The legacy query form is also supported:

`/?engine=google&q=query`

### CORS

Allowed browser origins are:

- `https://0fluffstart.pages.dev`
- `https://development.0fluffstart.pages.dev`
- Valid `chrome-extension://` origins
- Valid `moz-extension://` origins
- `http://localhost` and `http://127.0.0.1` development origins

Requests with an unrecognized `Origin` are rejected. Requests without an `Origin` header remain usable for non-browser/server-side clients.

## Deployment

### Prerequisites

- Node.js (v18 or higher)
- Cloudflare CLI (Wrangler)

### Local Setup

1. Clone the repository:
   `git clone https://github.com/jbuilds-g/0fluffstart-suggest-cors-proxy.git`
2. Enter the directory:
   `cd 0fluffstart-suggest-cors-proxy`
3. Install dependencies:
   `npm install`
4. Run locally:
   `npx wrangler dev`

### Deploy to Cloudflare

`npx wrangler deploy`

## License

Distributed under the MIT License. See `LICENSE` for details.
