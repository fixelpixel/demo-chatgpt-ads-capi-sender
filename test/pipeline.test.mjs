import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import { Journal } from '../src/journal.mjs';
import { createPipeline } from '../src/pipeline.mjs';
import { order, attr, NOW, setup, dryConfig, fakeSendConfig } from './support/helpers.mjs';

function pipeline(journal, extra = {}) {
  return createPipeline({ journal, config: dryConfig, clock: () => NOW, ...extra });
}
test('unknown consent blocks all collection even when order claims granted', async t => {
  const { journal, path } = await setup(t);
  const input = order(); input.customer.phone = 'bad phone';
  assert.deepEqual(await pipeline(journal)(input), { status: 'consent_blocked' });
  assert.equal(await readFile(path, 'utf8'), '{"kind":"delivery","status":"consent_blocked"}\n');
});
test('granted current state with matching snapshot permits one payload', async t => {
  const { journal } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  let calls = 0;
  assert.equal((await pipeline(journal, { log: () => calls++ })(order())).status, 'dry_run');
  assert.equal(calls, 1);
});
test('denied, missing or stale order snapshots are blocked despite current grant', async t => {
  const { journal } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  for (const [name, value] of [['measurement_consent', 'denied'], ['measurement_consent', undefined], ['measurement_consent_revision', '0'], ['measurement_session_id', 'demo-session-other']]) {
    assert.equal((await pipeline(journal)(attr(order(), name, value))).status, 'consent_blocked');
  }
});
test('withdrawal blocks retry and regrant does not replay an earlier consent epoch', async t => {
  const { journal } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  await journal.setConsent('demo-session-001', 'denied');
  assert.equal((await pipeline(journal)(order())).status, 'consent_blocked');
  await journal.setConsent('demo-session-001', 'granted');
  assert.equal((await pipeline(journal)(order())).status, 'consent_blocked');
  assert.equal((await pipeline(journal)(attr(order(), 'measurement_consent_revision', '3'))).status, 'dry_run');
});
test('concurrent duplicate deliveries build and log only one payload', async t => {
  const { journal, path } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  const process = pipeline(journal);
  const results = await Promise.all(Array.from({ length: 8 }, () => process(order())));
  assert.equal(results.filter(x => x.status === 'dry_run').length, 1);
  assert.equal(results.filter(x => x.status === 'duplicate').length, 7);
  assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, 2);
});
test('journal restart preserves both dedup and latest denial', async t => {
  const { journal, path } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  await pipeline(journal)(order());
  const reopened = await Journal.open(path);
  assert.equal((await pipeline(reopened)(order())).status, 'duplicate');
  await reopened.setConsent('demo-session-001', 'denied');
  assert.equal((await pipeline(await Journal.open(path))(order())).status, 'consent_blocked');
});
test('failed fake send releases identity, retries with same id and stops after success', async t => {
  const { journal } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  const ids = [];
  const process = pipeline(journal, { config: fakeSendConfig, transport: async payload => {
    ids.push(payload.events[0].id);
    if (ids.length === 1) throw new Error('synthetic failure');
    return { http_status: 202 };
  } });
  assert.equal((await process(order())).status, 'send_failed');
  assert.equal((await process(order())).status, 'sent');
  assert.equal((await process(order())).status, 'duplicate');
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});
test('failed fake send followed by withdrawal cannot retry or forward obref', async t => {
  const { journal } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  let sends = 0;
  const process = pipeline(journal, { config: fakeSendConfig, transport: async () => { sends++; throw new Error('synthetic failure'); } });
  assert.equal((await process(order())).status, 'send_failed');
  await journal.setConsent('demo-session-001', 'denied');
  assert.equal((await process(order())).status, 'consent_blocked');
  assert.equal(sends, 1);
});
test('dry-run completion never suppresses fake-send completion or another pixel', async t => {
  const { journal } = await setup(t);
  await journal.setConsent('demo-session-001', 'granted');
  await pipeline(journal)(order());
  assert.equal((await pipeline(journal, { config: fakeSendConfig, transport: async () => ({ http_status: 200 }) })(order())).status, 'sent');
  assert.equal((await pipeline(journal, { config: { ...dryConfig, pixelId: 'demo-pixel-002' } })(order())).status, 'dry_run');
});
test('corrupt journal fails closed; invalid consent updates are rejected', async t => {
  const { journal, path } = await setup(t);
  assert.throws(() => journal.setConsent('invalid-session', 'granted'));
  assert.throws(() => journal.setConsent('demo-session-001', 'yes'));
  await appendFile(path, '{partial');
  await assert.rejects(Journal.open(path));
});
