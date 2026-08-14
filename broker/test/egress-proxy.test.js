'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EgressProxyError,
  EgressProxyRegistry,
} = require('../lib/egress-proxy');

const workspaceId = '00000000-0000-0000-0000-000000000001';

function writeConfig(directory, assignments = { [workspaceId]: 'proxy-sp-01' }) {
  const configFile = path.join(directory, 'egress-proxies.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      profiles: {
        'proxy-sp-01': {
          url: 'http://cliente:senha-super-secreta@proxy.example.com:8080',
          vendor: 'ProxyAds',
          country: 'BR',
          region: 'SP',
          dedicated: true,
          rotation: 'disabled',
        },
      },
      assignments,
    }),
  );
  fs.chmodSync(configFile, 0o640);
  return configFile;
}

test('keeps provider egress disabled until the controlled rollout', () => {
  const registry = new EgressProxyRegistry({ mode: 'disabled', configFile: null });
  registry.start();
  assert.equal(registry.resolve(workspaceId), null);
  assert.equal(registry.getStatus().ready, true);
  assert.equal(registry.getStatus().configured, false);
});

test('resolves one HTTP proxy per workspace and keeps public status secret-free', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-proxy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = new EgressProxyRegistry({
    mode: 'required',
    configFile: writeConfig(directory),
  });

  registry.start();
  const proxy = registry.resolve(workspaceId);
  assert.deepEqual(proxy, {
    id: 'proxy-sp-01',
    vendor: 'ProxyAds',
    country: 'BR',
    region: 'SP',
    protocol: 'http',
    host: 'proxy.example.com',
    port: '8080',
    server: 'proxy.example.com:8080',
    username: 'cliente',
    password: 'senha-super-secreta',
  });
  const publicStatus = JSON.stringify(registry.getStatus());
  assert.doesNotMatch(publicStatus, /senha-super-secreta/);
  assert.doesNotMatch(publicStatus, /proxy\.example\.com/);
  assert.equal(registry.getStatus().profileCount, 1);
  assert.equal(registry.getStatus().assignmentCount, 1);
});

test('fails closed when a workspace has no dedicated assignment', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = new EgressProxyRegistry({
    mode: 'required',
    configFile: writeConfig(directory),
  });
  registry.start();

  assert.throws(
    () => registry.resolve('00000000-0000-0000-0000-000000000002'),
    (error) =>
      error instanceof EgressProxyError &&
      error.code === 'EGRESS_PROXY_ASSIGNMENT_MISSING',
  );
});

test('rejects a proxy profile shared by two workspaces', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-shared-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = writeConfig(directory, {
    [workspaceId]: 'proxy-sp-01',
    '00000000-0000-0000-0000-000000000002': 'proxy-sp-01',
  });
  const registry = new EgressProxyRegistry({ mode: 'required', configFile });

  assert.throws(
    () => registry.start(),
    (error) =>
      error instanceof EgressProxyError &&
      error.code === 'EGRESS_PROXY_CONFIG_INVALID',
  );
  assert.equal(registry.getStatus().ready, false);
  assert.equal(registry.getStatus().error, 'config_invalid');
});

test('rejects SOCKS in the shared hub contract because WAHA expects HTTP', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-socks-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'egress-proxies.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      profiles: {
        'proxy-sp-01': {
          url: 'socks5://cliente:senha@proxy.example.com:1080',
          vendor: 'ProxyAds',
          country: 'BR',
          dedicated: true,
          rotation: 'disabled',
        },
      },
      assignments: { [workspaceId]: 'proxy-sp-01' },
    }),
  );
  fs.chmodSync(configFile, 0o640);
  const registry = new EgressProxyRegistry({ mode: 'required', configFile });
  assert.throws(() => registry.start(), /Arquivo de proxies inválido/);
});

test('rejects a proxy file readable by every local user', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-mode-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = writeConfig(directory);
  fs.chmodSync(configFile, 0o644);
  const registry = new EgressProxyRegistry({ mode: 'required', configFile });

  assert.throws(
    () => registry.start(),
    (error) =>
      error instanceof EgressProxyError &&
      error.code === 'EGRESS_PROXY_CONFIG_INVALID',
  );
});
