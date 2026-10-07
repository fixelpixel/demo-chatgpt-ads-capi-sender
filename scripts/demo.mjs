import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createApp, sign, DEMO_TOKEN } from '../src/server.mjs';
import { createConsentGatedPixel } from '../browser/snippet.mjs';
import { configuration } from '../src/sender.mjs';

// Always dry-run, irrespective of shell credentials. All fetch calls below are loopback.
await mkdir(resolve('out'), { recursive: true });
const runDirectory = await mkdtemp(resolve('out/run-'));
const journalPath = join(runDirectory, 'journal.jsonl');
const order = JSON.parse(await readFile(new URL('../fixtures/order-paid.json', import.meta.url), 'utf8'));
order.created_at = new Date().toISOString();
const pixelCalls = [], outcomes = [];
let savedAttributes = {};
let app;

async function start() {
  app = await createApp({ journalPath, config: configuration() });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${app.server.address().port}`;
}
async function stop() {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
}
let base = await start();

async function post(input, signature) {
  const body = JSON.stringify(input);
  const response = await fetch(`${base}/webhooks/orders`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': signature ?? sign(body),
      'X-Shopify-Shop-Domain': 'demo-store.example', 'X-Shopify-Topic': 'orders/paid',
    }, body,
  });
  return { http: response.status, ...await response.json() };
}
async function check(label, input, expected, signature) {
  const result = await post(input, signature);
  assert.equal(result.status ?? result.error, expected);
  outcomes.push({ scenario: label, ...result });
  console.log(`${label}: HTTP ${result.http} ${result.status ?? result.error}`);
}
const pixel = createConsentGatedPixel({
  sessionId: 'demo-session-001',
  loadSdk: async () => (...args) => pixelCalls.push(args), // No SDK download.
  getLandingUrl: () => order.landing_site,
  getCookies: () => '__obref=demo-browser-reference-001',
  saveCartAttributes: async attrs => { savedAttributes = { ...savedAttributes, ...attrs }; },
  recordConsent: async (session_id, state) => {
    const response = await fetch(`${base}/demo/consent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEMO_TOKEN}` },
      body: JSON.stringify({ session_id, state }),
    });
    assert.equal(response.status, 200);
    return response.json();
  },
});
function attach(input) {
  return { ...input, note_attributes: Object.entries(savedAttributes).map(([name, value]) => ({ name, value })) };
}

try {
  console.log('Mode: dry-run; synthetic browser Pixel; platform/store network calls: 0');
  await check('unknown consent', order, 'consent_blocked');
  await pixel.setConsent('granted');
  const browserEvent = await pixel.purchase({ orderId: order.id, amount: 4200, currency: 'EUR' });
  const captured = attach(order);
  assert.equal(browserEvent.event_id, captured.note_attributes.find(x => x.name === 'chatgpt_event_id').value);
  await check('granted purchase', captured, 'dry_run');
  await check('webhook retry', captured, 'duplicate');
  await check('tampered signature', captured, 'invalid_signature', 'demo-invalid-signature');
  await pixel.setConsent('denied');
  await check('withdrawn consent retry', captured, 'consent_blocked');
  await pixel.setConsent('granted');
  await check('stale consent epoch', captured, 'consent_blocked');
  const next = { ...order, id: 'demo-order-002' };
  await pixel.purchase({ orderId: next.id, amount: 4200, currency: 'EUR' });
  const fresh = attach(next);
  await check('new purchase after regrant', fresh, 'dry_run');
  await stop(); base = await start();
  await check('retry after server restart', fresh, 'duplicate');
  const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const payloads = records.filter(x => x.payload);
  assert.equal(payloads.length, 2);
  const measures = pixelCalls.filter(x => x[0] === 'measure');
  assert.equal(measures.length, 2);
  assert.deepEqual(measures.map(x => x[3].event_id), payloads.map(x => x.payload.events[0].id));
  const summary = { mode: 'dry-run', platform_network_calls: 0, scenarios: outcomes,
    browser_events: measures.length, stored_payloads: payloads.length, id_parity: true };
  await writeFile(join(runDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(runDirectory, 'pixel-calls.json'), `${JSON.stringify(pixelCalls, null, 2)}\n`);
  console.log(`Verified ${outcomes.length} scenarios; browser/server ID parity: yes; payloads: ${payloads.length}`);
  console.log(`Artifacts: ${relative(process.cwd(), runDirectory)}/`);
} finally { await stop(); }
