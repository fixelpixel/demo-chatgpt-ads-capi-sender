import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsentGatedPixel } from '../browser/snippet.mjs';
import { buildPayload, attributes } from '../src/payload.mjs';
import { order, NOW } from './support/helpers.mjs';

function browser(extra = {}) {
  const calls = [], carts = [], reads = [];
  let revision = 0;
  const pixel = createConsentGatedPixel({ sessionId: 'demo-session-001',
    loadSdk: async () => { reads.push('sdk'); return (...args) => calls.push(args); },
    getLandingUrl: () => { reads.push('url'); return 'https://demo-store.example/?oppref=demo-click-A%2B%2F%3D'; },
    getCookies: () => { reads.push('cookies'); return '__obref=demo-browser-reference-001'; },
    recordConsent: async () => ({ revision: ++revision }),
    saveCartAttributes: async attrs => carts.push(attrs), ...extra,
  });
  return { pixel, calls, carts, reads };
}
const purchase = { orderId: 'demo-order-001', amount: 4200, currency: 'EUR' };

test('unknown and denied consent do not load SDK, read identifiers or measure', async () => {
  const { pixel, calls, reads } = browser();
  assert.equal((await pixel.purchase(purchase)).status, 'consent_blocked');
  await pixel.setConsent('denied');
  assert.equal((await pixel.purchase(purchase)).status, 'consent_blocked');
  assert.deepEqual(calls, []); assert.deepEqual(reads, []);
});
test('consent false precedes init and true; browser event_id equals server id and amount', async () => {
  const { pixel, calls } = browser();
  await pixel.setConsent('granted');
  const measured = await pixel.purchase(purchase);
  assert.deepEqual(calls.slice(0, 3), [['consent', false], ['init', { pixelId: 'demo-pixel-001' }], ['consent', true]]);
  const input = order(); input.note_attributes = Object.entries(measured.attributes).map(([name, value]) => ({ name, value }));
  const event = buildPayload(input, attributes(input), NOW).events[0];
  assert.equal(calls[3][3].event_id, event.id);
  assert.deepEqual(calls[3][2], event.data);
  assert.equal(calls[3][1], event.type);
  assert.equal(event.oppref, 'demo-click-A+/=');
});
test('revocation clears forwarded refs and stops future events without replay', async () => {
  const { pixel, calls, carts, reads } = browser();
  await pixel.setConsent('granted'); await pixel.purchase(purchase);
  await pixel.setConsent('denied');
  const previousReads = reads.length;
  assert.equal((await pixel.purchase(purchase)).status, 'consent_blocked');
  assert.equal(reads.length, previousReads);
  assert.equal(calls.filter(x => x[0] === 'measure').length, 1);
  assert.deepEqual(carts.at(-1), { chatgpt_oppref: '', chatgpt_obref: '', measurement_consent: 'denied' });
});
test('withdrawal during SDK loading cannot enable measurement', async () => {
  let finishLoad;
  const loaded = new Promise(resolve => { finishLoad = resolve; });
  const calls = [];
  const { pixel } = browser({ loadSdk: () => loaded });
  const granting = pixel.setConsent('granted');
  await new Promise(resolve => setImmediate(resolve));
  await pixel.setConsent('denied');
  finishLoad((...args) => calls.push(args)); await granting;
  assert.equal((await pixel.purchase(purchase)).status, 'consent_blocked');
  assert.deepEqual(calls, [['consent', false]]);
});
test('withdrawal during cart write suppresses browser event and clears stale identifiers', async () => {
  let release, started;
  const writing = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const saved = [];
  const { pixel, calls } = browser({ saveCartAttributes: async attrs => {
    if (attrs.chatgpt_event_id) { started(); await pending; }
    saved.push(attrs);
  } });
  await pixel.setConsent('granted');
  const measuring = pixel.purchase(purchase); await writing;
  await pixel.setConsent('denied'); release();
  assert.equal((await measuring).status, 'consent_blocked');
  assert.equal(calls.filter(x => x[0] === 'measure').length, 0);
  assert.equal(saved.at(-1).measurement_consent, 'denied');
  assert.equal(saved.at(-1).chatgpt_obref, '');
});
test('failed consent persistence leaves pixel blocked', async () => {
  const { pixel, calls } = browser({ recordConsent: async () => { throw new Error('synthetic failure'); } });
  await assert.rejects(pixel.setConsent('granted'));
  assert.equal((await pixel.purchase(purchase)).status, 'consent_blocked'); assert.deepEqual(calls, []);
});
