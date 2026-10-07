import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, sign, DEMO_TOKEN } from '../../src/server.mjs';
import { configuration } from '../../src/sender.mjs';
import { Journal } from '../../src/journal.mjs';

export const NOW = Date.parse('2026-10-07T10:00:00Z');
const fixture = JSON.parse(await readFile(new URL('../../fixtures/order-paid.json', import.meta.url), 'utf8'));
export function order() { return structuredClone(fixture); }
export function attr(value, name, content) {
  value.note_attributes = value.note_attributes.filter(x => x.name !== name);
  if (content !== undefined) value.note_attributes.push({ name, value: content });
  return value;
}
export async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'demo-capi-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.jsonl');
  return { path, journal: await Journal.open(path) };
}
export async function localApp(t, options = {}) {
  const storage = await setup(t);
  const app = await createApp({ journalPath: storage.path, clock: () => NOW, log: () => {}, ...options });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, ...storage, base };
}
export async function consent(base, state = 'granted', token = DEMO_TOKEN) {
  return fetch(`${base}/demo/consent`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: 'demo-session-001', state }),
  });
}
export async function postOrder(base, value = order(), overrides = {}) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return fetch(`${base}/webhooks/orders`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': sign(raw),
      'X-Shopify-Shop-Domain': 'demo-store.example', 'X-Shopify-Topic': 'orders/paid', ...overrides },
    body: raw,
  });
}
export const dryConfig = configuration();
export const fakeSendConfig = { mode: 'send', pixelId: 'demo-pixel-001', apiKey: 'demo-api-key-not-real' };
