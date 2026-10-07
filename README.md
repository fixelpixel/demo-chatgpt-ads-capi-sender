# ChatGPT Ads Conversions API sender demo

Built by Daniil Maximkin (taskfordaniel.com).

This demo accompanies the [measurement use case](https://taskfordaniel.com/use-cases/measuring-chatgpt-ads/)
and the [EU tracking guide](https://taskfordaniel.com/guides/chatgpt-ads-tracking-eu/).

A small server-side purchase sender demonstrating a browser Pixel and an order webhook sharing one conversion
identity, with a separate consent gate on both routes.

**Node 22, ES modules, zero dependencies. Synthetic data only.** The only shop
is `demo-store.example`; every order, customer, session, click and browser ID is
made up. Default delivery builds, prints and stores payloads without contacting
OpenAI or any store. The executable demo uses a fake browser Pixel and loopback
HTTP requests. No external accounts or credentials are needed.

## Run

Use Node 22 on your PATH. There is nothing to install.

```sh
npm test
npm run demo
npm start
```

`npm run demo` starts the real HTTP server on an ephemeral loopback port,
forwards attributes from the browser module into a synthetic signed order,
and asserts these outcomes:

```text
Mode: dry-run; synthetic browser Pixel; platform/store network calls: 0
unknown consent: HTTP 200 consent_blocked
granted purchase: HTTP 200 dry_run
webhook retry: HTTP 200 duplicate
tampered signature: HTTP 401 invalid_signature
withdrawn consent retry: HTTP 200 consent_blocked
stale consent epoch: HTTP 200 consent_blocked
new purchase after regrant: HTTP 200 dry_run
retry after server restart: HTTP 200 duplicate
Verified 8 scenarios; browser/server ID parity: yes; payloads: 2
Artifacts: out/run-*/
```

The two JSON dry-run payload log lines and npm's command header are omitted
above; the artifact directory suffix varies on each run.

Each invocation gets a fresh `out/run-*/` directory containing
`journal.jsonl`, `summary.json` and `pixel-calls.json`. The fixture timestamp is
refreshed for the demo; tests use a fixed clock. `npm start` listens only on
`127.0.0.1:8787` and uses `out/journal.jsonl`, preserving consent and dedup state
across restarts. `GET /health` reports the selected mode.

## Flow and consent contract

```text
CMP adapter -> current consent + revision -> authenticated local consent store
     |
     +-> after grant only: load Pixel, consent(false), init, consent(true)
     +-> capture landing oppref / __oppref and __obref; save order attributes
     +-> measure(order_created, data, {event_id})

signed orders/paid webhook -> verify HMAC and synthetic shop -> current consent
  -> check order consent revision -> shared ID check -> normalize + SHA-256
  -> dedup [Pixel ID, order_created, id] -> dry-run journal + console
                                      -> optional explicit live sender
```

Consent starts unknown and blocks measurement payloads and forwarding. The webhook's consent attribute
alone is insufficient: its session must have a current server-side grant, and
the order must contain that grant's revision. Every update increments the
revision, so denial and later regrant do not replay earlier orders. Check the
gate before hashing, building a payload, processing a retry or sending. A
blocked decision stores no payload or matching identifiers.

The API has no dedicated measurement-consent field. `opt_out: true` is included
as a separate future-personalization choice; it does not bypass the gate.
The Pixel defaults to granted: the snippet explicitly queues denial before
initialization. This example also delays SDK loading until permission exists,
because SDK consent blocks event pings rather than all SDK network activity.
Revocation stops browser measurement immediately and clears forwarded refs.

`POST /demo/consent` accepts `{ "session_id": "demo-session-001", "state":
"granted" }` with `Authorization: Bearer demo-control-token-not-for-production`.
Other states are `denied` and `unknown`. The response contains the revision.
This is a **demo control endpoint**, not a verified CMP or identity service.
It is server-to-server; do not put a production control token into browser code.

`POST /webhooks/orders` requires `Content-Type: application/json`,
`X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the exact raw body),
`X-Shopify-Shop-Domain: demo-store.example`, and `X-Shopify-Topic: orders/paid`.
Use `sign()` from `src/server.mjs` for local fixtures. Other topics are ignored.
The 64 KiB body limit is deliberate. Bad signatures return 401, malformed
orders 400, blocked consent and duplicates 200, and failed live delivery 502
so the caller can retry.

## Browser snippet and shared identity

`browser/snippet.mjs` exports `createConsentGatedPixel()`. It takes adapters for
the CMP record, cart/order persistence, SDK loading, landing URL and cookies.
The runnable demo wires these to local HTTP and a fake Pixel; tests use spies.
An optional `loadOpenAiSdk(window, document)` adapter is provided for a real
storefront integration when the site operator enables the Pixel. Importing the module loads nothing.

The module's core browser calls are:

```js
oaiq('consent', false);
oaiq('init', { pixelId: 'demo-pixel-001' });
oaiq('consent', true); // only after a successfully recorded grant
oaiq('measure', 'order_created',
  { type: 'contents', amount: 4200, currency: 'EUR' },
  { event_id: 'demo-store.example:order:demo-order-001', opt_out: true });
```

`eventId()` in `src/shared.mjs` is used by both paths. The server requires the
same value in `chatgpt_event_id`; missing or mismatched values fail instead of
silently generating a different ID. A production adapter must expose the
stable order identity on the confirmation page and persist the contract into
the order. A random ID generated independently on each route will not work.

| Order note attribute | Purpose |
| --- | --- |
| `measurement_session_id` | Synthetic session pointing to current consent |
| `measurement_consent` | Consent snapshot (`granted` required) |
| `measurement_consent_revision` | Exact current consent revision |
| `chatgpt_event_id` | Browser `event_id`, forwarded as API `id` |
| `chatgpt_oppref` | Original permitted landing/cookie click reference |
| `chatgpt_obref` | Original permitted `__obref` browser reference |

These are this demo's attribute names, not official Shopify or OpenAI consent
fields. No Shopify API is called. Cart persistence is an explicit adapter
boundary demonstrated in `scripts/demo.mjs`.

Capture `oppref` from the permitted landing URL, falling back to `__oppref`.
Decode URL/cookie encoding once, preserve the resulting string exactly, and
save it with the order. Forward it as `events[].oppref`. Read `__obref` only
with permission and forward it unchanged as `events[].user.obref`. The server
does not recover lost attribution from a stale landing URL. The Pixel itself
manages its cookies; this module does not invent or renew tracking cookies.

## Payload, hashing and dedup

Each purchase has `type: order_created`, integer `timestamp_ms`,
`action_source: web`, the synthetic shop origin as `source_url`, and
`data: { type: contents, amount, currency }`. The order-status URL and its
access token are never forwarded. Amounts are converted exactly from decimal
strings into currency minor units: EUR/USD use 2 decimals, JPY 0 and KWD 3.
Other currencies fail explicitly. Events older than seven days or more than
ten minutes ahead are rejected.

The optional event-scoped `user` has documented plural arrays:
`emails_sha256`, `phone_numbers_sha256`, `external_ids_sha256`,
`first_names_sha256`, and `last_names_sha256`.

| Identifier | Normalization before UTF-8 SHA-256 |
| --- | --- |
| Email | Trim surrounding whitespace, lowercase |
| Phone | Preserve country code; remove whitespace, parentheses, periods, hyphens, leading `+`, leading zeroes; require 8-15 digits |
| External ID | Trim surrounding whitespace, preserve case and other characters |
| Name | Lowercase, remove whitespace and ASCII punctuation, preserve non-ASCII characters and accents |

Hashes are lowercase 64-character hex strings. Raw values are never copied
into the payload or journal. `oppref` and `obref` are opaque references and
remain unhashed. This example intentionally omits IP, user agent and geography.

OpenAI's browser/server dedup key is Pixel ID + event name + shared ID. The
local journal also prevents repeated webhook processing, including concurrent
deliveries and process restarts. Dry-run and live completion are separate
namespaces so a preview cannot suppress a future send. A failed send records a
failure without claiming completion; a retry rechecks consent and uses the
same event ID. This tests our contract, not actual OpenAI dedup/reporting.

## Optional explicit send

The default stays dry-run even when credentials are present. Only
`node --env-file=.env src/server.mjs --send` can enable the CLI's live sender,
and both `OPENAI_PIXEL_ID` and `OPENAI_CONVERSIONS_API_KEY` must be non-blank.
Missing credentials fail startup. `.env` is ignored by git; `.env.example` has
no credentials. `DEMO_WEBHOOK_SECRET`, `DEMO_CONTROL_TOKEN` and `PORT` configure
the local ingress. No environment values or authorization headers are logged.

The live sender uses a fixed `POST https://bzr.openai.com/v1/events?pid=...`,
a server-only Bearer Conversions API key, a five-second timeout and no redirects.
There is no configurable destination URL. It sends one event per request.
Tests replace its fetch/transport with mocks; the executable demo always forces
dry-run. Live sending has **not** been exercised in this project.

## Layout

```text
.
|-- .env.example          empty live credentials and synthetic ingress defaults
|-- .gitignore            dependencies, generated output and environment files
|-- LICENSE               Apache-2.0, Copyright 2026 Daniil Maximkin
|-- README.md
|-- package.json          project metadata and run/test commands
|-- browser/
|   `-- snippet.mjs       consent-gated Pixel and optional SDK adapter
|-- docs/
|   `-- verification.md   recorded checks and scope of evidence
|-- fixtures/
|   `-- order-paid.json   synthetic Shopify-like order
|-- scripts/
|   `-- demo.mjs          loopback HTTP acceptance scenario
|-- src/
|   |-- identifiers.mjs   documented normalization and SHA-256
|   |-- journal.mjs       persistent consent, revisions and dedup
|   |-- payload.mjs       order validation and CAPI payload builder
|   |-- pipeline.mjs      gate, dedup, dry-run and optional send orchestration
|   |-- sender.mjs        explicit send configuration and fixed endpoint
|   |-- server.mjs        signed webhook and local consent HTTP endpoints
|   `-- shared.mjs        browser/server event identity and attribution capture
`-- test/
    |-- browser.test.mjs
    |-- identifiers.test.mjs
    |-- payload.test.mjs
    |-- pipeline.test.mjs
    |-- sender.test.mjs
    |-- server.test.mjs
    `-- support/
        `-- helpers.mjs  synthetic fixtures and temporary loopback servers
```

## Evidence

The demo provides a standalone sender plus a browser path, one shared purchase
identity, preserved click and browser references, and a consent decision before
measurement. Withdrawal and retry behavior are exercised by consent revision tests and
the runnable regrant scenario. `GET /health`, failed-send status and the JSONL
journal provide basic delivery visibility. There is no external alert service.

The demo supplies reproducible technical evidence. It supplies
no client results, match-quality improvements, real campaign attribution or
proof that OpenAI actually counted a test purchase once.

## Limits

- All orders, consent states and references are synthetic. No real Shopify
  subscription, checkout, CMP integration or SDK execution was tested. The
  browser module is exercised with a fake Pixel, not a real browser SDK.
- The consent endpoint uses a shared demo token and invented session IDs. A
  production consent source needs authenticated session ownership, trustworthy
  CMP updates, retention policy and order-attribute wiring. The webhook's
  consent snapshot is not independent proof of lawful permission.
- This is one Node process and one local append-only journal. Multiple workers
  need shared transactions/locks; there is no journal rotation or dedup expiry.
  The journal is not an fsync-backed durable queue. Corrupt JSON fails startup;
  an interrupted append requires repair. A crash after remote receipt but
  before local completion may resend the same ID, relying on platform dedup.
- Processing is synchronous. There is no durable background queue, automatic
  backoff or reconciliation job. Retries come from the caller and recheck
  consent. A withdrawal recorded after a send has begun cannot retract that
  request; consent updates and delivery are serialized within this process.
- Only paid purchase events and four currencies are implemented. String order
  IDs are required to avoid JavaScript precision loss. No refunds, custom
  events, multiple shops, native app events or arbitrary item metadata.
- No real CAPI request, SDK load or Ads Manager receipt was tested. A successful
  HTTP response is transport receipt, not proven attribution, reporting or
  legal compliance. No account configuration or campaign conversion setup.
- Hashed identifiers and opaque references are still sensitive data if this
  pattern is adapted for real users. Demo output uses made-up values only;
  a production journal needs appropriate access and retention controls.

## Sources

Field names and behavior rechecked on 2026-10-07 using official OpenAI documentation:

- [Conversions API](https://developers.openai.com/ads/conversions-api): event
  schema, normalization, plural hash fields, `oppref` and `user.obref`, timestamps.
- [Measurement Pixel](https://developers.openai.com/ads/measurement-pixel):
  consent defaults, initialization order, `event_id`, cookies and dedup.
- [Conversion Tracking](https://developers.openai.com/ads/conversion-tracking):
  same Pixel ID, event name and browser/server identity.

These sources describe API behavior; this demo's tests establish local behavior
only. See [verification](docs/verification.md).

## License

Apache-2.0. Copyright 2026 Daniil Maximkin. See [LICENSE](LICENSE).
