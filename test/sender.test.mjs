import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, requestUrl, sendPayload } from '../src/sender.mjs';
import { fakeSendConfig } from './support/helpers.mjs';

test('credentials alone never enable network delivery; send requires both credentials and explicit flag', () => {
  assert.equal(configuration([], { OPENAI_PIXEL_ID: 'demo-pixel', OPENAI_CONVERSIONS_API_KEY: 'demo-key' }).mode, 'dry-run');
  assert.throws(() => configuration(['--send'], {}));
  assert.throws(() => configuration(['--send'], { OPENAI_PIXEL_ID: 'demo-pixel' }));
  assert.throws(() => configuration(['--unexpected'], {}));
});
test('fixed endpoint encodes pixel ID as a query value', () => {
  const url = new URL(requestUrl('demo-pixel&extra=demo'));
  assert.equal(url.origin, 'https://bzr.openai.com'); assert.equal(url.pathname, '/v1/events');
  assert.equal(url.searchParams.get('pid'), 'demo-pixel&extra=demo'); assert.equal(url.searchParams.has('extra'), false);
});
test('sender uses Bearer CAPI key, JSON POST, timeout and rejects redirects (mock fetch only)', async () => {
  let request;
  const receipt = await sendPayload({ events: [] }, fakeSendConfig, async (url, options) => {
    request = { url, options }; return new Response('', { status: 202 });
  });
  assert.equal(receipt.http_status, 202);
  assert.equal(request.options.headers.Authorization, 'Bearer demo-api-key-not-real');
  assert.equal(request.options.method, 'POST'); assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { events: [] });
  assert.ok(request.options.signal instanceof AbortSignal);
});
test('sender rejects disabled mode and non-2xx without exposing response bodies (mock fetch only)', async () => {
  await assert.rejects(sendPayload({}, { mode: 'dry-run' }, async () => { throw new Error('must not run'); }), /not enabled/);
  await assert.rejects(sendPayload({}, fakeSendConfig, async () => new Response('demo-sensitive-echo', { status: 429 })), error => {
    assert.equal(error.message.includes('demo-sensitive-echo'), false); return true;
  });
});
