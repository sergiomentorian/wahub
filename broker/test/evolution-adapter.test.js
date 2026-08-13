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
