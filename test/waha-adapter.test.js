'use strict';

const assert = require('node:assert/strict');
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
