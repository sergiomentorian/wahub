'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const adapter = require('../adapters/mentorian');

test('status reports a disconnected Baileys source without failing the migration endpoint', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: 'migration_source_not_connected',
        message: 'source offline',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );

  const status = await adapter.status(
    { apiUrl: 'https://gateway.example.com', sharedSecret: 'x'.repeat(32) },
    'workspace-123',
  );

  assert.deepEqual(status, { connected: false, jid: null });
});

test('export keeps rejecting a disconnected Baileys source', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        error: 'migration_source_not_connected',
        message: 'source offline',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );

  await assert.rejects(
    adapter.exportPassport(
      { apiUrl: 'https://gateway.example.com', sharedSecret: 'x'.repeat(32) },
      'workspace-123',
    ),
    /source offline/,
  );
});
