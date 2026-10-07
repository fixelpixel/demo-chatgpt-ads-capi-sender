import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { localApp, consent, postOrder, order, attr, fakeSendConfig } from './support/helpers.mjs';

test('HTTP dry run: signed purchase, duplicate and consent withdrawal', async t => {
  const { base, path } = await localApp(t);
  assert.equal((await (await fetch(`${base}/health`)).json()).mode, 'dry-run');
  assert.equal((await (await postOrder(base)).json()).status, 'consent_blocked');
  assert.equal((await consent(base)).status, 200);
  assert.equal((await (await postOrder(base)).json()).status, 'dry_run');
  assert.equal((await (await postOrder(base)).json()).status, 'duplicate');
  await consent(base, 'denied');
  assert.equal((await (await postOrder(base)).json()).status, 'consent_blocked');
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(x => x.payload).length, 1);
});
test('HTTP rejects bad HMAC, wrong shop, unauthorized consent and invalid JSON', async t => {
  const { base } = await localApp(t);
  assert.equal((await postOrder(base, order(), { 'X-Shopify-Hmac-Sha256': 'demo-bad-signature' })).status, 401);
  assert.equal((await postOrder(base, order(), { 'X-Shopify-Shop-Domain': 'other-store.example' })).status, 400);
  assert.equal((await consent(base, 'granted', 'demo-wrong-token')).status, 401);
  assert.equal((await postOrder(base, '{bad-json')).status, 400);
  assert.equal((await postOrder(base, 'null')).status, 400);
});
test('HTTP ignores other topics and rejects unsupported media, routes and oversized payloads', async t => {
  const { base } = await localApp(t);
  assert.equal((await (await postOrder(base, order(), { 'X-Shopify-Topic': 'orders/create' })).json()).status, 'ignored_topic');
  assert.equal((await postOrder(base, order(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
  assert.equal((await postOrder(base, ' '.repeat(65537))).status, 413);
});
test('HTTP rejects mismatched event ID before recording a payload', async t => {
  const { base, path } = await localApp(t);
  await consent(base);
  assert.equal((await postOrder(base, attr(order(), 'chatgpt_event_id', 'demo-wrong-event'))).status, 400);
  assert.equal((await readFile(path, 'utf8')).includes('payload'), false);
});
test('HTTP fake transport failure is retryable 502; withdrawal prevents the retry', async t => {
  let calls = 0;
  const { base } = await localApp(t, { config: fakeSendConfig, transport: async () => { calls++; throw new Error('synthetic failure'); } });
  await consent(base);
  assert.equal((await postOrder(base)).status, 502);
  await consent(base, 'denied');
  assert.equal((await (await postOrder(base)).json()).status, 'consent_blocked');
  assert.equal(calls, 1);
});
