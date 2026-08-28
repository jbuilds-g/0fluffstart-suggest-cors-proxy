# 0fluffstart-suggest-cors-proxy

A lightweight, zero-logs CORS proxy built for Cloudflare Workers. Designed specifically for 0FluffStart to fetch real-time search suggestions without exposing client IP addresses or keypress metadata to upstream search engines.

## Features

- **Privacy-First:** Strips tracking headers and client IP metadata before forwarding requests.
- **Multi-Engine Support:** Proxies autocomplete endpoints for Google, Bing, DuckDuckGo, and Brave.
- **Edge Performance:** Runs on Cloudflare's global network for ultra-low latency.
- **Rate Limiting:** Built-in KV binding support to prevent abuse.

## Supported Providers

- Google (`/google?q=query`)
- Bing (`/bing?q=query`)
- DuckDuckGo (`/duckduckgo?q=query`)
- Brave (`/brave?q=query`)

## Deployment

### Prerequisites

- Node.js (v18 or higher)
- Cloudflare CLI (Wrangler)

### Local Setup

1. Clone the repository:
   git clone https://github.com/jbuilds-g/0fluffstart-suggest-cors-proxy.git
   cd 0fluffstart-suggest-cors-proxy

2. Install dependencies:
   npm install

3. Run locally for testing:
   npx wrangler dev

### Deploy to Cloudflare

Deploy directly to your Cloudflare account with a single command:

npx wrangler deploy

## License

Distributed under the MIT License. See `LICENSE` for details.
