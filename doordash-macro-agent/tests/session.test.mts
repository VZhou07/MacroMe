import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Steel from 'steel-sdk';
import { createSession, sessionTimeoutMs, DEFAULT_SESSION_TIMEOUT_MINUTES } from '../src/session.js';

test('timeout accepts longer durations without a local clamp and rejects invalid values', () => {
  assert.equal(sessionTimeoutMs('60'), 3600000);
  assert.equal(sessionTimeoutMs('1440'), 86400000);
  for (const value of ['', '0', '-1', 'Infinity', 'NaN', 'abc']) {
    assert.throws(() => sessionTimeoutMs(value), /positive number/);
  }
});

test('session creation forwards the requested lifetime and preserves the profile options', async (t) => {
  const before = process.env.MACROME_SESSION_TIMEOUT_MINUTES;
  process.env.MACROME_SESSION_TIMEOUT_MINUTES = '60';
  t.after(() => { if (before === undefined) delete process.env.MACROME_SESSION_TIMEOUT_MINUTES; else process.env.MACROME_SESSION_TIMEOUT_MINUTES = before; });
  let params: any;
  const client = { sessions: {
    create: async (options: any) => { params = options; return { id: 'test', timeout: options.timeout }; },
    release: async () => assert.fail('Accepted session must remain open'),
  } } as unknown as Steel;
  await createSession(client, { profileId: 'profile', persistProfile: false });
  assert.equal(params.timeout, 3600000);
  assert.equal(params.profileId, 'profile');
  assert.equal(params.persistProfile, false);
  assert.equal('inactivityTimeout' in params, false);
});

test('a shorter provider lifetime is released and reported instead of silently accepted', async () => {
  let released = false;
  const client = { sessions: {
    create: async () => ({ id: 'short', timeout: 60000 }),
    release: async (id: string) => { assert.equal(id, 'short'); released = true; },
  } } as unknown as Steel;
  await assert.rejects(createSession(client), /shorter than the requested/);
  assert.equal(released, true);
});

test('default lifetime is explicitly longer than the previous fourteen minutes', () => {
  assert.ok(DEFAULT_SESSION_TIMEOUT_MINUTES > 14);
});
