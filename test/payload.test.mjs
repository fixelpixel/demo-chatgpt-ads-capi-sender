import test from 'node:test';
import assert from 'node:assert/strict';
import { attributes, buildPayload, minorUnits } from '../src/payload.mjs';
import { captureAttribution, readCookie, dedupKey, eventId } from '../src/shared.mjs';
import { order, attr, NOW } from './support/helpers.mjs';

test('order payload uses documented fields and browser identity without raw PII or order access URL', () => {
  const input = order(), payload = buildPayload(input, attributes(input), NOW);
  const event = payload.events[0];
  assert.equal(event.id, eventId(input.id));
  assert.equal(event.type, 'order_created');
  assert.equal(event.timestamp_ms, Date.parse(input.created_at));
  assert.deepEqual(event.data, { type: 'contents', amount: 4200, currency: 'EUR' });
  assert.equal(event.action_source, 'web');
  assert.equal(event.source_url, 'https://demo-store.example');
  assert.equal(event.oppref, 'demo-click-A+/=');
  assert.equal(event.user.obref, 'demo-browser-reference-001');
  assert.equal(event.opt_out, true);
  const text = JSON.stringify(payload);
  for (const raw of [input.customer.email.trim().toLowerCase(), input.customer.phone, 'demo-access-token', 'measurement_consent']) assert.equal(text.includes(raw), false);
});
test('missing or mismatched browser event ID is rejected', () => {
  for (const id of [undefined, 'different-demo-event']) {
    const input = attr(order(), 'chatgpt_event_id', id);
    assert.throws(() => buildPayload(input, attributes(input), NOW), /Browser event_id/);
  }
});
test('dedup identity includes pixel ID, event name and id without delimiter collisions', () => {
  const key = dedupKey('demo-pixel-A', 'order_created', 'demo-order-A');
  for (const triple of [['demo-pixel-B', 'order_created', 'demo-order-A'], ['demo-pixel-A', 'lead_created', 'demo-order-A'], ['demo-pixel-A', 'order_created', 'demo-order-B']]) assert.notEqual(key, dedupKey(...triple));
  assert.notEqual(dedupKey('a|b', 'c', 'd'), dedupKey('a', 'b|c', 'd'));
});
test('capture decodes oppref once and preserves its case, plus, slash and surrounding space', () => {
  assert.deepEqual(captureAttribution('https://demo-store.example/?oppref=%20Demo%2B%2F%3D%252B%20', '__obref=demo-Browser%2BRef'), { oppref: ' Demo+/=%2B ', obref: 'demo-Browser+Ref' });
});
test('cookie fallback applies only when the URL value is empty or missing', () => {
  assert.equal(captureAttribution('https://demo-store.example/?oppref=', '__oppref=demo-cookie%2B').oppref, 'demo-cookie+');
  assert.equal(captureAttribution('https://demo-store.example/?oppref=demo-new', '__oppref=demo-old').oppref, 'demo-new');
  assert.deepEqual(captureAttribution('https://demo-store.example/', ''), {});
});
test('malformed cookie encoding is safely ignored and synthetic URL boundary is enforced', () => {
  assert.equal(readCookie('__obref=%XX', '__obref'), undefined);
  assert.throws(() => captureAttribution('http://demo-store.example/', ''));
  assert.throws(() => captureAttribution('https://other-store.example/', ''));
  assert.throws(() => captureAttribution('https://demo:secret@demo-store.example/', ''));
});
test('server forwards stored references exactly and does not recapture from a stale landing URL', () => {
  const input = attr(attr(order(), 'chatgpt_oppref', ' Demo-Opaque+/= '), 'chatgpt_obref', ' Demo-Obref ');
  const event = buildPayload(input, attributes(input), NOW).events[0];
  assert.equal(event.oppref, ' Demo-Opaque+/= ');
  assert.equal(event.user.obref, ' Demo-Obref ');
  attr(input, 'chatgpt_oppref', undefined); attr(input, 'chatgpt_obref', undefined);
  const omitted = buildPayload(input, attributes(input), NOW).events[0];
  assert.equal('oppref' in omitted, false); assert.equal('obref' in omitted.user, false);
});
test('money converts exact decimal strings for two, zero and three minor-unit currencies', () => {
  assert.equal(minorUnits('42.00', 'EUR'), 4200);
  assert.equal(minorUnits('0.29', 'USD'), 29);
  assert.equal(minorUnits('4200.00', 'JPY'), 4200);
  assert.equal(minorUnits('4.205', 'KWD'), 4205);
  assert.equal(minorUnits('42', 'EUR'), 4200);
});
test('money rejects wrong precision, unsupported currency, float input and overflow', () => {
  for (const [price, currency] of [['1.001', 'USD'], ['1.1', 'JPY'], ['1', 'XXX'], ['-2', 'EUR'], [0.29, 'EUR'], ['9007199254740992', 'JPY']]) assert.throws(() => minorUnits(price, currency));
});
test('timestamp boundaries follow seven-day past and ten-minute future limits', () => {
  for (const delta of [-7 * 86400000, 600000]) {
    const input = order(); input.created_at = new Date(NOW + delta).toISOString();
    assert.doesNotThrow(() => buildPayload(input, attributes(input), NOW));
  }
  for (const value of [new Date(NOW - 7 * 86400000 - 1).toISOString(), new Date(NOW + 600001).toISOString(), 'invalid', '2026-10-07T10:00:00']) {
    const input = order(); input.created_at = value;
    assert.throws(() => buildPayload(input, attributes(input), NOW));
  }
});
test('invalid order shape, unpaid orders and ambiguous duplicate attributes are rejected', () => {
  const unpaid = order(); unpaid.financial_status = 'pending'; assert.throws(() => buildPayload(unpaid, attributes(unpaid), NOW));
  const foreign = order(); foreign.shop_domain = 'other-store.example'; assert.throws(() => buildPayload(foreign, attributes(foreign), NOW));
  const duplicate = order(); duplicate.note_attributes.push(duplicate.note_attributes[0]); assert.throws(() => attributes(duplicate));
  assert.throws(() => eventId(123));
});
