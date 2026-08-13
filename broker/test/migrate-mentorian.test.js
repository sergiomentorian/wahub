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

function registryFor({ importFailure = false, releaseFailure = false, webhookFailure = false, destinationId = 'waha' } = {}) {
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
    async setWebhook() {
      calls.push('webhook-destination');
      if (webhookFailure) throw new Error('webhook failed');
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
      [destinationId]: { adapter: destination, ctx: {} },
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

test('Mentorian to Evolution registers the webhook and commits after connection', async () => {
  const fixture = registryFor({ destinationId: 'evolution' });
  const result = await migrate.run(fixture.registry, {
    from: { api: 'mentorian', id: 'workspace-123' },
    to: { api: 'evolution', name: 'workspace-123' },
    webhook: { url: 'https://app.example.test/api/webhooks/whatsapp/evolution', secret: 'x'.repeat(64) },
  });

  assert.equal(result.success, true);
  assert.equal(result.to.api, 'evolution');
  assert.deepEqual(fixture.calls, [
    'export',
    'create-destination',
    'release-source',
    'import-destination',
    'webhook-destination',
    'commit-source',
  ]);
});

test('same-family migration imports signal keys before activating Evolution', async () => {
  const calls = [];
  let sourceReleased = false;
  let destinationActivated = false;
  const registry = {
    waha: {
      ctx: {},
      adapter: {
        family: 'baileys',
        async status() {
          return sourceReleased
            ? { connected: false }
            : { connected: true, jid: '5511999999999:1@s.whatsapp.net' };
        },
        async exportPassport() {
          calls.push('export-passport');
          return { passport: passportFixture() };
        },
        async exportStore() {
          calls.push('export-store');
          return { format: 'baileys-key-map-v1', entries: { 'pre-key-1': { keyId: 1 } } };
        },
        async releaseForMigration() {
          sourceReleased = true;
          calls.push('release-source');
        },
        async importPassport() {
          calls.push('rollback-source');
        },
      },
    },
    evolution: {
      ctx: {},
      adapter: {
        family: 'baileys',
        async list() { return []; },
        async createSession() { return { id: 'workspace-123' }; },
        async importPassport() {
          calls.push('import-passport');
          return { ok: true, requiresActivation: true };
        },
        async importStore(_ctx, _id, blob) {
          assert.equal(blob.entries['pre-key-1'].keyId, 1);
          calls.push('import-store');
        },
        async activateImportedSession() {
          destinationActivated = true;
          calls.push('activate');
        },
        async status() { return { connected: destinationActivated }; },
      },
    },
  };

  const result = await migrate.run(registry, {
    from: { api: 'waha', id: 'workspace-123' },
    to: { api: 'evolution', name: 'workspace-123' },
    tier: 2,
  });

  assert.equal(result.connected, true);
  assert.deepEqual(calls, [
    'export-passport',
    'export-store',
    'release-source',
    'import-passport',
    'import-store',
    'activate',
  ]);
});

test('Evolution destinations receive a longer readiness window', () => {
  assert.equal(migrate.destinationReadyTimeoutMs('waha', 'evolution'), 75000);
  assert.equal(migrate.destinationReadyTimeoutMs('mentorian', 'evolution'), 90000);
  assert.equal(migrate.destinationReadyTimeoutMs('waha', 'mentorian'), 90000);
  assert.equal(migrate.destinationReadyTimeoutMs('evolution', 'waha'), 25000);
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

test('Mentorian source is restored when WAHA webhook is not confirmed', async () => {
  const fixture = registryFor({ webhookFailure: true });

  await assert.rejects(
    migrate.run(fixture.registry, {
      from: { api: 'mentorian', id: 'workspace-123' },
      to: { api: 'waha', name: 'workspace-123' },
      webhook: { url: 'https://app.example.test/webhook', hmacKey: 'x'.repeat(64) },
    }),
    (error) => error && error.code === 'WEBHOOK_FAILED',
  );
  assert.deepEqual(fixture.calls, [
    'export',
    'create-destination',
    'release-source',
    'import-destination',
    'webhook-destination',
    'release-destination',
    'rollback-source',
  ]);
});

test('WAHA migrates back to Mentorian Baileys and confirms destination', async () => {
  const calls = [];
  let wahaReleased = false;
  const registry = {
    waha: {
      ctx: {},
      adapter: {
        family: 'baileys',
        async status() {
          return wahaReleased
            ? { connected: false, jid: null }
            : { connected: true, jid: '5511999999999:1@s.whatsapp.net' };
        },
        async exportPassport() {
          calls.push('export-waha');
          return { passport: passportFixture() };
        },
        async releaseForMigration() {
          wahaReleased = true;
          calls.push('release-waha');
        },
      },
    },
    mentorian: {
      ctx: {},
      adapter: {
        family: 'baileys',
        async importPassport() {
          calls.push('import-mentorian');
          return { jid: '5511999999999:1@s.whatsapp.net' };
        },
        async status() {
          return { connected: true, jid: '5511999999999:1@s.whatsapp.net' };
        },
      },
    },
  };

  const result = await migrate.run(registry, {
    from: { api: 'waha', id: 'workspace-123' },
    to: { api: 'mentorian', id: 'workspace-123' },
  });

  assert.equal(result.success, true);
  assert.equal(result.to.api, 'mentorian');
  assert.deepEqual(calls, ['export-waha', 'release-waha', 'import-mentorian']);
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

test('Mentorian pre-check waits through a transient reconnect before exporting', async () => {
  let attempts = 0;
  const expected = { passport: passportFixture() };
  const adapter = {
    async exportPassport() {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('Conecte o WhatsApp no Baileys antes de iniciar a migração.');
        error.code = 'migration_source_not_connected';
        error.status = 409;
        throw error;
      }
      return expected;
    },
  };

  const result = await migrate.exportMentorianSourceWhenReady(
    adapter,
    {},
    'workspace-123',
    { timeoutMs: 50, intervalMs: 0 },
  );

  assert.equal(result, expected);
  assert.equal(attempts, 3);
});

test('Mentorian pre-check does not retry a non-transient export failure', async () => {
  let attempts = 0;
  const adapter = {
    async exportPassport() {
      attempts += 1;
      const error = new Error('invalid credentials');
      error.code = 'credentials_invalid';
      throw error;
    },
  };

  await assert.rejects(
    migrate.exportMentorianSourceWhenReady(adapter, {}, 'workspace-123', {
      timeoutMs: 50,
      intervalMs: 0,
    }),
    /invalid credentials/,
  );
  assert.equal(attempts, 1);
});
