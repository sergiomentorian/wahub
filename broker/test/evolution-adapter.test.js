'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const adapter = require('../adapters/evolution');

test('createSession reuses an existing disconnected Evolution instance', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response(JSON.stringify([
    { name: 'workspace-123', connectionStatus: 'close' },
  ]), { status: 200, headers: { 'content-type': 'application/json' } });

  const result = await adapter.createSession(
    { apiUrl: 'https://evolution.example.com', apiKey: 'secret' },
    'workspace-123',
  );
  assert.deepEqual(result, {
    id: 'workspace-123',
    name: 'workspace-123',
    reused: true,
  });
});

test('createSession refuses to overwrite an active Evolution instance', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response(JSON.stringify([
    { name: 'workspace-123', connectionStatus: 'open' },
  ]), { status: 200, headers: { 'content-type': 'application/json' } });

  await assert.rejects(
    adapter.createSession(
      { apiUrl: 'https://evolution.example.com', apiKey: 'secret' },
      'workspace-123',
    ),
    /já está conectada/,
  );
});

test('importPassport falls back to connect when Evolution restart returns error in HTTP 200', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init && init.method });
    if (String(url).includes('/instance/restart/')) {
      return new Response(JSON.stringify({ error: true, message: 'instance is not connected' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('/instance/connect/')) {
      return new Response(JSON.stringify({ instance: { state: 'connecting' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('SELECT id FROM "Instance"')) return { rows: [{ id: 'instance-id' }] };
      if (sql.includes('SELECT creds FROM "Session"')) return { rows: [{ creds: '' }] };
      return { rows: [] };
    },
    release() {},
  };
  const key = Buffer.alloc(32, 7).toString('base64');
  const result = await adapter.importPassport(
    { pool: { connect: async () => client }, apiUrl: 'https://evolution.example.com', apiKey: 'secret' },
    'workspace-123',
    {
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
    },
  );

  assert.equal(result.ok, true);
  assert.equal(queries.some((sql) => sql.includes('INSERT INTO "Session"')), true);
  assert.deepEqual(
    requests.map((request) => request.url.replace('https://evolution.example.com', '')),
    ['/instance/restart/workspace-123', '/instance/connect/workspace-123'],
  );
});
