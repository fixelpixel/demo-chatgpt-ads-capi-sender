# Verification record

Tests and demo rechecked on 2026-10-07 with Node v22.22.2. All input values are synthetic.

| Check | Observed result |
| --- | --- |
| `npm test` with Node 22 on PATH | 44 tests passed; 0 failed, skipped, cancelled or todo |
| `node scripts/demo.mjs` | 8 asserted HTTP scenarios passed; 2 browser events and 2 stored payloads; IDs match |
| `npm start` with local port 18787 | CLI started in dry-run mode on `127.0.0.1` |
| `GET http://127.0.0.1:18787/health` | HTTP 200, `{"status":"ok","mode":"dry-run"}` |
| `node --check` | All 16 JavaScript modules passed syntax checks |

The CLI smoke-test process was stopped after the health check. Demo artifacts
are generated under ignored `out/run-*/` directories; they are not committed.
The automated scenario creates fresh output on every invocation and refreshes
the synthetic order timestamp. Tests use a fixed clock and temporary journals.

## Acceptance evidence

- `test/browser.test.mjs`: SDK loading and reference reads wait for consent;
  denial precedes init; browser event ID, type, value and currency match the
  server event; withdrawal during SDK loading or cart writes suppresses events;
  failed consent persistence leaves measurement blocked.
- `test/identifiers.test.mjs`: email, phone, external ID and Unicode name
  normalization; UTF-8 SHA-256; plural array fields; unhashed browser reference.
- `test/payload.test.mjs`: opaque click-reference handling, cookie fallback,
  absent refs, exact minor-unit conversion, timestamp boundaries, shared-ID
  rejection, dedup tuple and omission of raw customer data/order access URLs.
- `test/pipeline.test.mjs`: missing/current/denied/stale consent, concurrent
  retries, restart persistence, fake-send failure recovery and withdrawal,
  separate dry-run/live namespaces and corrupt-JSON failure.
- `test/sender.test.mjs`: explicit opt-in configuration, fixed endpoint,
  encoded pixel ID, Bearer key, timeout, redirect rejection and non-2xx handling.
  All delivery calls use mock fetch, never the real API.
- `test/server.test.mjs`: real loopback HTTP requests with signed payloads,
  grant/withdrawal, duplicate delivery, unauthorized input, size/media checks
  and fake transport failure.
- `scripts/demo.mjs`: integrates the browser module, consent endpoint, signed
  order ingress, payload storage and actual server restart. Assertions cover
  unknown consent, successful dry run, duplicate webhook, bad signature,
  withdrawal, stale regrant revision, new purchase and dedup after restart.

## Boundaries

There were no store or ad-platform network calls during execution. Tests and
the demo do not load the real browser SDK. Optional sending is exercised only
through injected fake transports. No OpenAI account, actual dedup result,
campaign attribution or Ads Manager reporting was validated. Official docs
were read-only sources, not API delivery targets.

This demo accompanies the [measurement use case](https://taskfordaniel.com/use-cases/measuring-chatgpt-ads/)
and the [EU tracking guide](https://taskfordaniel.com/guides/chatgpt-ads-tracking-eu/).

See the README's Limits section for the demo consent endpoint, single-process
journal, synchronous delivery, in-flight withdrawal and production integration
boundaries.
