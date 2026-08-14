'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const adapter = require('../adapters/evolution');

const assignedProxy = {
  id: 'proxy-sp-01',
  host: 'proxy.example.com',
  port: '8080',
  protocol: 'http',
  username: 'cliente',
  password: 'senha-secreta',
};

test('createSession sends the dedicated proxy to Evolution', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method,
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (String(url).includes('/instance/fetchInstances')) {
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ instance: { instanceName: 'workspace-123' } }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };

  await adapter.createSession(
    {
      apiUrl: 'https://evolution.example.com',
      apiKey: 'secret',
      egressProxyRegistry: { resolve: () => assignedProxy },
    },
    'workspace-123',
  );

  assert.deepEqual(calls[1].body, {
    instanceName: 'workspace-123',
    integration: 'WHATSAPP-BAILEYS',
    proxyHost: 'proxy.example.com',
    proxyPort: '8080',
    proxyProtocol: 'http',
    proxyUsername: 'cliente',
    proxyPassword: 'senha-secreta',
  });
});

test('createSession configures the proxy before reusing Evolution', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method,
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (String(url).includes('/instance/fetchInstances')) {
      return new Response(
        JSON.stringify([{ name: 'workspace-123', connectionStatus: 'close' }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ proxy: { enabled: true } }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };

  await adapter.createSession(
    {
      apiUrl: 'https://evolution.example.com',
      apiKey: 'secret',
      egressProxyRegistry: { resolve: () => assignedProxy },
    },
    'workspace-123',
  );

  assert.match(calls[1].url, /\/proxy\/set\/workspace-123$/);
  assert.deepEqual(calls[1].body, {
    enabled: true,
    host: 'proxy.example.com',
    port: '8080',
    protocol: 'http',
    username: 'cliente',
    password: 'senha-secreta',
  });
});

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

test('importPassport defers activation and then falls back to connect on restart error', async (t) => {
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
  assert.equal(result.requiresActivation, true);
  assert.equal(queries.some((sql) => sql.includes('INSERT INTO "Session"')), true);
  assert.deepEqual(requests, []);

  await adapter.activateImportedSession(
    { apiUrl: 'https://evolution.example.com', apiKey: 'secret' },
    'workspace-123',
  );
  assert.deepEqual(
    requests.map((request) => request.url.replace('https://evolution.example.com', '')),
    ['/instance/restart/workspace-123', '/instance/connect/workspace-123'],
  );
});

test('importStore writes Baileys keys to the Evolution instance Redis hash', async () => {
  const calls = [];
  const ctx = {
    redisUri: 'redis://example.invalid',
    redisPrefix: 'evolution',
    redis: {
      async del(key) { calls.push(['del', key]); },
      async hset(key, ...values) { calls.push(['hset', key, ...values]); },
    },
    pool: {
      async query() { return { rows: [{ id: 'instance-cuid' }] }; },
    },
  };

  await adapter.importStore(ctx, 'workspace-123', {
    format: 'baileys-key-map-v1',
    entries: { 'pre-key-1': { keyId: 1, keyData: Buffer.from('key') } },
  });

  assert.deepEqual(calls[0], ['del', 'evolution:instance:instance-cuid']);
  assert.equal(calls[1][0], 'hset');
  assert.equal(calls[1][1], 'evolution:instance:instance-cuid');
  assert.equal(calls[1][2], 'pre-key-1');
  assert.match(calls[1][3], /"keyId":1/);
});
