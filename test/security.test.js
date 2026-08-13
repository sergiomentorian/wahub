'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { requireMutationsEnabled, requireSecret } = require('../lib/util');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('mutation gate fails closed', () => {
  const res = responseRecorder();
  let nextCalled = false;

  requireMutationsEnabled(false)({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'MUTATIONS_DISABLED' });
});

test('mutation gate allows explicitly enabled operations', () => {
  const res = responseRecorder();
  let nextCalled = false;

  requireMutationsEnabled(true)({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.body, null);
});

test('secret gate denies an invalid secret', () => {
  const res = responseRecorder();
  let nextCalled = false;
  const req = { get: () => 'wrong' };

  requireSecret('expected')(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'UNAUTHORIZED' });
});
