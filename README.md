# Sherweb MCP Server

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A Model Context Protocol (MCP) server for Sherweb cloud marketplace and partner portal. Enables AI assistants to manage customer subscriptions, browse the product catalog, and handle billing operations.

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects Claude (or any MCP-compatible AI) to your Sherweb environment.

> **Part of the [MSP Claude Plugins](https://github.com/WYRE-AI) ecosystem** — a growing suite of AI integrations for the MSP stack. Built by MSPs, for MSPs.

## Installation

```bash
npm install @wyre-ai/sherweb-mcp
```

## Configuration

Copy [`.env.example`](.env.example) and set the variables below.

| Variable | Required | Description |
|----------|----------|-------------|
| `SHERWEB_CLIENT_ID` | For stdio and `AUTH_MODE=env` | Sherweb API client ID |
| `SHERWEB_CLIENT_SECRET` | For stdio and `AUTH_MODE=env` | Sherweb API client secret |
| `SHERWEB_SUBSCRIPTION_KEY` | For stdio and `AUTH_MODE=env` | Sherweb API subscription key |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-Sherweb-Client-ID`, `X-Sherweb-Client-Secret`, and `X-Sherweb-Subscription-Key` on each `/mcp` request and never falls back to `SHERWEB_*`. `env` uses those variables only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `your-s2s-secret`, `placeholder`, `secret`, and similar copied examples). Compose will not start without it. Never commit a real value. Generate one with `openssl rand -hex 32`. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored and the override is logged. A placeholder secret is still refused. |
| `MCP_HTTP_HOST` | No | Bind address when `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` is set. Defaults to `127.0.0.1`. The container image sets `0.0.0.0`. Without a real secret the listener is `127.0.0.1`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. A missing or invalid header returns 401, before vendor credentials are read. The secret is never written to logs.

The header value is `t=<unix seconds>,v1=<hex hmac-sha256>`. `v1` is HMAC-SHA256 over the exact ASCII string `t=<unix seconds>`, keyed with `CONDUIT_S2S_SECRET`, hex-encoded (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock.

```
t=1710000000,v1=<hmac-sha256("t=1710000000", CONDUIT_S2S_SECRET) as hex>
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-Sherweb-Client-ID`, `X-Sherweb-Client-Secret`, and `X-Sherweb-Subscription-Key`. Those headers are the only credential source for that request. A request missing any of them returns 401 and does not fall back to `SHERWEB_*` in the process environment.

## Usage

### Running with Claude Desktop

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sherweb-mcp": {
      "command": "npx",
      "args": ["@wyre-ai/sherweb-mcp"],
      "env": {
        "SHERWEB_CLIENT_ID": "your-sherweb-client-id",
        "SHERWEB_CLIENT_SECRET": "your-sherweb-client-secret",
        "SHERWEB_SUBSCRIPTION_KEY": "your-sherweb-subscription-key"
      }
    }
  }
}
```

### Running with Claude Code (CLI)

```bash
claude mcp add sherweb-mcp \
  -e SHERWEB_CLIENT_ID=your-value \
  -e SHERWEB_CLIENT_SECRET=your-value \
  -e SHERWEB_SUBSCRIPTION_KEY=your-value \
  -- npx -y @wyre-ai/sherweb-mcp
```

### Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, Sherweb credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t sherweb-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  sherweb-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not pass `SHERWEB_CLIENT_ID`, `SHERWEB_CLIENT_SECRET`, or `SHERWEB_SUBSCRIPTION_KEY` into the container:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `SHERWEB_*`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e SHERWEB_CLIENT_ID=your-value \
  -e SHERWEB_CLIENT_SECRET=your-value \
  -e SHERWEB_SUBSCRIPTION_KEY=your-value \
  -p 127.0.0.1:8080:8080 \
  sherweb-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` only (a wider `MCP_HTTP_HOST` is ignored) and logs a warning:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## Available Domains

### Billing
Distributor payable charges for a billing period, and detail for an individual
charge. Sherweb returns charges only as a per-period collection, so both tools
take an optional `date` identifying the period.

### Catalog
Browse the products a given customer can be sold. Catalogs are per-customer in
Sherweb — there is no global product list — so `customerId` is required.

### Customers
List and look up customers, and read the receivable charges you bill them for a
billing period.

### Subscriptions
List a customer's subscriptions, get one subscription's details, and submit
quantity amendments. Amendments are **asynchronous**: submitting returns a
tracking ID, and `sherweb_subscriptions_amendment_status` reports the outcome.

## Interactive Subscription Card (MCP Apps)

`sherweb_subscriptions_get` renders as an interactive, read-only card in MCP
Apps hosts (Claude Desktop/web) showing the product, customer, status,
quantity, billing cycle, commitment/renewal dates, and fees; plain-JSON
behavior is unchanged in other hosts. The card is neutral by default and
brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars
(`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`,
`MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`) — no rebuild
needed.

## Development

```bash
# Clone the repository
git clone https://github.com/WYRE-AI/sherweb-mcp.git
cd sherweb-mcp

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# HTTP transport refuses to start until CONDUIT_S2S_SECRET is set
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http npm start

# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_ALLOW_INSECURE_DEV=1 MCP_TRANSPORT=http npm start
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) if present, or open an issue to discuss changes.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
