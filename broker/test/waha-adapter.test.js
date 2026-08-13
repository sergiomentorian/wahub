'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const adapter = require('../adapters/waha');

test('createSession reuses an existing stopped WAHA session', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ method: options.method, url: String(url) });
    if (options.method === 'POST') {
      return new Response(
        JSON.stringify({ message: "Session 'workspace-123' already exists." }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ name: 'workspace-123', status: 'STOPPED' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const result = await adapter.createSession(
    { apiUrl: 'https://waha.example.com', apiKey: 'secret' },
    'workspace-123',
  );

  assert.deepEqual(result, {
    id: 'workspace-123',
    name: 'workspace-123',
    reused: true,
  });
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET']);
});

test('createSession refuses to reuse an existing active WAHA session', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') {
      return new Response(
        JSON.stringify({ message: "Session 'workspace-123' already exists." }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ name: 'workspace-123', status: 'WORKING' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  await assert.rejects(
    adapter.createSession(
      { apiUrl: 'https://waha.example.com', apiKey: 'secret' },
      'workspace-123',
    ),
    /CREATE_FAILED|already exists/,
  );
});

test('exportStore returns NOWEB signal key files without creds.json', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waha-store-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, 'noweb', 'workspace-123');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'creds.json'), '{}');
  fs.writeFileSync(path.join(sessionDir, 'pre-key-1.json'), JSON.stringify({ keyId: 1 }));
  fs.writeFileSync(path.join(sessionDir, 'session-contact.json'), JSON.stringify({ chain: 'ok' }));

  const store = await adapter.exportStore(
    { sessionsDir: root, engine: 'NOWEB' },
    'workspace-123',
  );

  assert.equal(store.format, 'baileys-key-map-v1');
  assert.deepEqual(store.entries['pre-key-1'], { keyId: 1 });
  assert.deepEqual(store.entries['session-contact'], { chain: 'ok' });
  assert.equal(Object.hasOwn(store.entries, 'creds'), false);
});
