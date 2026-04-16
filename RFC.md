# RFC: Resend Support Toolkit

**Version:** 2.2  
**Status:** Active  
**Date:** 2026-04-16

---

## Overview

The Resend Support Toolkit is a locally-hosted developer utility for testing and debugging email infrastructure. It provides two primary tools in a single web interface: an **Email Tester** for sending emails via the Resend API, and a **DNS Lookup** tool for inspecting DNS records and diagnosing email deliverability configuration.

The app is designed for support engineers, developers, and anyone integrating with [Resend](https://resend.com) who needs a fast feedback loop when testing transactional email — without relying on external SaaS dashboards or wrestling with CORS in the browser.

---

## Architecture

```
Browser (public/index.html)
        │
        │  HTTP (fetch)
        ▼
Express Server (server.js)  :3001
        │
        ├──▶  Resend API (api.resend.com)
        ├──▶  GitHub Raw (react-email templates)
        └──▶  Google DNS-over-HTTPS (dns.google)
```

The app is a two-layer architecture: a single-page frontend served as a static file, and a thin Express proxy server that handles all external API calls. No database. No build step.

---

## Components

### 1. Express Server (`server.js`)

The backend is a Node.js Express server that acts as a proxy layer between the browser and external services. It exists for one primary reason: CORS. Browsers block direct calls to the Resend API from `localhost`, so all API requests are routed through this server.

**Responsibilities:**
- Serve the static frontend from `/public`
- Proxy email send requests to `api.resend.com/emails`
- Proxy template fetch requests to `api.resend.com/templates`
- Serve bundled react.email template metadata
- Fetch and transpile react.email TSX source from GitHub
- Proxy DNS queries to Google DNS-over-HTTPS
- Run SPF/DKIM/DMARC/MX diagnostic checks

**Port:** `3001` (configurable via `PORT` env var)  
**Dependencies:** `express`, `node-fetch`, `cors`

---

### 2. Email Tester (Frontend Tool)

The email tester is the primary tool. It lets a user compose and send a real email through the Resend API and immediately see the API response.

**Fields:**
- **API Key** — Resend API key (`re_...`). Sent with every request. Stored only in memory (not localStorage). Toggle-to-reveal password field.
- **From** — Sender address. Must be from a domain verified in the user's Resend account.
- **To** — Recipient address.
- **Subject** — Email subject line.
- **Body (HTML)** — Raw HTML editor with a live Preview tab that renders the email in a sandboxed iframe.

**Template Sources:**  
Two distinct template import strips are available above the body editor:

- **Resend Account Templates** — Fetches the user's own templates from `GET /api/templates` using their API key, then imports the HTML from a selected template via `GET /api/templates/:id`.
- **react.email Templates** — A curated list of 18 open-source email templates (AWS, GitHub, Apple, Stripe, Airbnb, etc.) fetched from the `resend/react-email` GitHub repo. These are TSX files that get transpiled to HTML by the server before import.

**Keyboard Shortcut:** `Cmd/Ctrl+Enter` triggers send.

---

### 3. DNS Lookup (Frontend Tool)

A DNS record inspector backed by Google's DNS-over-HTTPS resolver (`dns.google/resolve`). All queries are routed server-side to avoid browser CORS restrictions.

**Record Types Supported:**  
`A`, `AAAA`, `MX`, `TXT`, `CNAME`, `NS`, `SOA`, `SRV`, `PTR`, `CAA`, `NAPTR`, `DNSKEY`, `DS`

The UI presents clickable type chips. Selecting **ANY** runs parallel queries across the 8 most common record types simultaneously and collates results into a single result card with per-type timing.

**Quick Lookup buttons** let users jump directly to:
- MX Records
- SPF / DKIM / DMARC (fetches TXT)
- CNAME

---

### 4. Email Diagnostics (`GET /api/dns/email-diag`)

A one-click email deliverability audit. Given a domain, it runs four DNS checks in parallel and returns a structured pass/warn/fail report:

| Check | What it tests |
|---|---|
| **MX Records** | At least one MX record exists |
| **SPF Record** | Single TXT record starting with `v=spf1`, enforced with `-all` or `~all` |
| **DMARC Record** | TXT at `_dmarc.<domain>` with `v=DMARC1`; warns if policy is not `reject` |
| **DKIM (default selector)** | TXT at `default._domainkey.<domain>` with `v=DKIM1` |

Results render as a checklist with icons and record values inline.

---

### 5. TSX → HTML Converter (`convertTsxToHtml`)

A server-side function that transpiles react.email component trees into plain HTML suitable for use in the email editor.

**What it does:**
- Extracts the `<Html>...</Html>` subtree from a TSX source file
- Maps react.email component names to HTML equivalents (`Text` → `p`, `Heading` → `h1`, `Button` → `a`, `Container` → `div`, etc.)
- Strips utility wrapper tags (`Tailwind`, `Font`, `Preview`)
- Converts Tailwind class names to inline `style` attributes via the `tailwindToInline` helper
- Converts JSX `style={{ }}` objects to inline CSS
- Replaces template expressions with placeholder values
- Prepends `<!DOCTYPE html>` if missing

**Tailwind coverage:** text/background color, font size, font weight, text alignment, margins, padding, width, display, border radius, and border properties — all using bracket notation or named scale values.

This is a best-effort converter. It handles the common patterns found in the react.email template library but is not a general-purpose TSX compiler.

---

### 6. Frontend UI (`public/index.html`)

A self-contained single HTML file. No framework, no bundler, no external JS dependencies. All styling is inline CSS; all interactivity is vanilla JavaScript.

**Layout:**
- **Header bar** — Logo, version badge, theme toggle
- **Left sidebar** — Tool navigation (Email Tester / DNS Lookup)
- **Center pane** — Active tool form
- **Resize handle** — Draggable column splitter (250px–700px)
- **Right pane** — Result panel showing response cards in reverse-chronological order

**Theming:**  
Full dark/light mode using CSS custom properties on the `data-theme` attribute. Preference is persisted to `localStorage`.

**Result Cards:**  
Each action (email send, DNS lookup, email diagnostic) appends a card to the result pane. Cards are color-coded: green for success, red for error, cyan for DNS, purple for diagnostics. JSON payloads are syntax-highlighted with token-level coloring.

**Responsive:**  
At viewports below 900px, the sidebar collapses to a horizontal scrollable tab bar and the result pane is hidden.

---

## API Surface

All routes are served by the Express server at `http://localhost:3001`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/send` | Send email via Resend |
| `GET` | `/api/templates` | List templates from Resend account |
| `GET` | `/api/templates/:id` | Fetch a single template's HTML |
| `GET` | `/api/react-email-templates` | List bundled react.email templates |
| `GET` | `/api/react-email-templates/source` | Fetch and convert a react.email TSX to HTML |
| `GET` | `/api/dns` | DNS record lookup (single type or ANY) |
| `GET` | `/api/dns/email-diag` | SPF/DKIM/DMARC/MX diagnostic check |

---

## Data Flow: Email Send

```
User fills form → clicks Send (or Cmd+Enter)
  → Browser: POST /api/send  { apiKey, from, to, subject, html }
  → Server validates fields (400 if missing)
  → Server: POST https://api.resend.com/emails  { Authorization: Bearer <apiKey> }
  → Resend returns { id } on success or error object on failure
  → Server forwards response to browser
  → Browser renders result card (success/error)
```

The API key is never logged or stored server-side. It passes through the proxy in memory only.

---

## Data Flow: DNS Lookup

```
User enters domain, selects type → clicks Lookup
  → Browser: GET /api/dns?domain=<domain>&type=<type>
  → Server normalizes domain (strips protocol, trailing slash, trailing dot)
  → If type=ANY: fires 8 parallel queries to dns.google
  → Each query: GET https://dns.google/resolve?name=<domain>&type=<typeCode>
  → Server parses and structures records by type (MX priority, SOA fields, etc.)
  → Returns collated { results, errors, timing } object
  → Browser renders DNS result card with per-type tables
```

---

## Non-Goals

- **Persistence** — No database, no history across sessions. Results live only in the current browser tab.
- **Multi-user** — Designed for single-user local use only. No authentication on the proxy endpoints.
- **Full TSX compilation** — The TSX-to-HTML converter handles the react.email template patterns specifically. It is not a general React renderer.
- **Production deployment** — This is a local dev tool. The proxy passes API keys in request bodies; it should not be exposed to the internet.
