'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const migrate = require('../migrate');

function passportFixture() {
  const key = Buffer.alloc(32, 7).toString('base64');
  return {
    noiseKey: { private: key },
    signedIdentityKey: { private: key },
    signedPreKey: {
      keyId: 1,
      keyPair: { private: key },
      signature: Buffer.alloc(64, 9).toString('base64'),
    },
    registrationId: 1,
    me: { id: '5511999999999:1@s.whatsapp.net' },
    account: {
      details: Buffer.from('details').toString('base64'),
      accountSignature: Buffer.from('signature').toString('base64'),
      deviceSignature: Buffer.from('device').toString('base64'),
    },
  };
}

function registryFor({ importFailure = false, releaseFailure = false } = {}) {
  const calls = [];
  let released = false;
  const source = {
    family: 'baileys',
    async status() {
      return released
        ? { connected: false }
        : { connected: true, jid: '5511999999999:1@s.whatsapp.net' };
    },
    async exportPassport() {
      calls.push('export');
      return { passport: passportFixture() };
    },
    async releaseForMigration() {
      if (releaseFailure) throw new Error('source pause failed');
      released = true;
      calls.push('release-source');
    },
    async commitMigration() {
      calls.push('commit-source');
    },
    async rollbackMigration() {
      released = false;
      calls.push('rollback-source');
    },
  };
  const destination = {
    family: 'baileys',
    async list() {
      return [];
    },
    async createSession(_ctx, name) {
      calls.push('create-destination');
      return { id: name };
    },
    async importPassport() {
      calls.push('import-destination');
      if (importFailure) throw new Error('destination import failed');
      return { ok: true, jid: '5511999999999:1@s.whatsapp.net' };
    },
    async status() {
      return { connected: true };
    },
    async releaseForMigration() {
      calls.push('release-destination');
    },
  };
  return {
    calls,
    registry: {
      mentorian: { adapter: source, ctx: {} },
      waha: { adapter: destination, ctx: {} },
    },
  };
}

test('Mentorian to WAHA commits only after destination confirms connected', async () => {
  const fixture = registryFor();
  const result = await migrate.run(fixture.registry, {
    from: { api: 'mentorian', id: 'workspace-123' },
    to: { api: 'waha', name: 'workspace-123' },
  });

  assert.equal(result.success, true);
  assert.equal(result.connected, true);
  assert.deepEqual(fixture.calls, [
    'export',
    'create-destination',
    'release-source',
    'import-destination',
    'commit-source',
  ]);
});

test('Mentorian source is restored when WAHA import fails', async () => {
  const fixture = registryFor({ importFailure: true });

  await assert.rejects(
    migrate.run(fixture.registry, {
      from: { api: 'mentorian', id: 'workspace-123' },
      to: { api: 'waha', name: 'workspace-123' },
    }),
    /destination import failed/,
  );
  assert.deepEqual(fixture.calls, [
    'export',
    'create-destination',
    'release-source',
    'import-destination',
    'release-destination',
    'rollback-source',
  ]);
});

test('WAHA import never starts when Mentorian source cannot be paused', async () => {
  const fixture = registryFor({ releaseFailure: true });

  await assert.rejects(
    migrate.run(fixture.registry, {
      from: { api: 'mentorian', id: 'workspace-123' },
      to: { api: 'waha', name: 'workspace-123' },
    }),
    (error) => error && error.code === 'SOURCE_RELEASE_FAILED',
  );
  assert.deepEqual(fixture.calls, [
    'export',
    'create-destination',
    'release-destination',
  ]);
});
