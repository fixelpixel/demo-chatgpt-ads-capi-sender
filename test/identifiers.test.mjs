import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalize, hashIdentifier, userData } from '../src/identifiers.mjs';
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');

test('email is trimmed and lowercased before SHA-256', () => {
  assert.equal(hashIdentifier('email', ' DEMO@demo-store.example '), digest('demo@demo-store.example'));
});
test('phone strips documented punctuation, leading plus and zeroes', () => {
  assert.equal(normalize('phone', '001.202 (555) 0142'), '12025550142');
  assert.throws(() => normalize('phone', '00+12'));
});
test('phone with country code hashes the normalized digits', () => {
  assert.equal(hashIdentifier('phone', ' +001 (202) 555-0142. '), digest('12025550142'));
});
test('invalid or local short phone is rejected rather than guessing a country code', () => {
  for (const input of ['555-0142', '+1 202 555 0142 ext 9', '1234567890123456', '']) {
    assert.throws(() => hashIdentifier('phone', input));
  }
});
test('external ID preserves case and internal punctuation', () => {
  assert.equal(hashIdentifier('external', ' Demo-Customer A '), digest('Demo-Customer A'));
  assert.notEqual(hashIdentifier('external', 'Demo'), hashIdentifier('external', 'demo'));
});
test('names remove ASCII punctuation and whitespace while preserving accents and non-ASCII punctuation', () => {
  assert.equal(normalize('name', ' Demo José!\t'), 'demojosé');
  assert.equal(normalize('name', "O'Demo"), 'odemo');
  assert.equal(normalize('name', 'Demo’Name'), 'demo’name');
  assert.equal(hashIdentifier('name', 'Demo José'), digest('demojosé'));
});
test('empty normalized identifiers and unknown kinds fail', () => {
  assert.throws(() => hashIdentifier('name', ' -- '));
  assert.throws(() => hashIdentifier('email', ' '));
  assert.throws(() => normalize('unsupported', 'demo'));
  assert.throws(() => normalize('external', 123));
});
test('user fields are documented plural arrays; obref is forwarded raw', () => {
  const user = userData({ email: 'demo@demo-store.example', phone: '+1 202 555 0142', id: 'demo-ID', first_name: 'Demo', last_name: 'Buyer' }, ' demo-obref ');
  assert.deepEqual(Object.keys(user).sort(), ['emails_sha256', 'external_ids_sha256', 'first_names_sha256', 'last_names_sha256', 'obref', 'phone_numbers_sha256']);
  for (const [key, value] of Object.entries(user)) if (key !== 'obref') assert.match(value[0], /^[a-f0-9]{64}$/);
  assert.equal(user.obref, ' demo-obref ');
  assert.deepEqual(userData({}), {});
});
