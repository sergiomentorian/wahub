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
  assert.deepEqual(
    {
      id: proxy.id,
      vendor: proxy.vendor,
      country: proxy.country,
      region: proxy.region,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    },
    {
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
    },
  );
  const publicStatus = JSON.stringify(registry.getStatus());
  assert.doesNotMatch(publicStatus, /senha-super-secreta/);
  assert.doesNotMatch(publicStatus, /proxy\.example\.com/);
  assert.equal(registry.getStatus().profileCount, 1);
  assert.equal(registry.getStatus().assignmentCount, 1);
  assert.equal(registry.listPublic()[0].label, 'Proxy 1');
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

test('assigned mode lets legacy workspaces use direct egress until a proxy is assigned', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-assigned-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = new EgressProxyRegistry({
    mode: 'assigned',
    configFile: writeConfig(directory),
  });
  registry.start();

  assert.equal(
    registry.resolve('00000000-0000-0000-0000-000000000002'),
    null,
  );
});

test('unassign keeps the purchased proxy available for reassignment', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-stock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = new EgressProxyRegistry({
    mode: 'assigned',
    configFile: writeConfig(directory),
  });
  registry.start();

  registry.remove(workspaceId);

  assert.equal(registry.getWorkspaceStatus(workspaceId).assigned, false);
  assert.equal(registry.listPublic().length, 1);
  assert.equal(registry.listPublic()[0].label, 'Proxy 1');
  assert.equal(registry.listPublic()[0].assigned, false);
  assert.doesNotMatch(JSON.stringify(registry.listPublic()), /senha-super-secreta/);
});

test('keeps unique asset labels stable across legacy inventory entries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-labels-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = writeConfig(directory, {});
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  raw.profiles['proxy-rj-02'] = {
    url: 'http://outro:segredo@proxy-2.example.com:8080',
    vendor: 'ProxyAds',
    country: 'BR',
    region: 'RJ',
    dedicated: true,
    rotation: 'disabled',
    label: 'Proxy 7',
  };
  fs.writeFileSync(configFile, JSON.stringify(raw));
  fs.chmodSync(configFile, 0o600);
  const registry = new EgressProxyRegistry({ mode: 'assigned', configFile });

  registry.start();

  assert.deepEqual(
    registry.listPublic().map((proxy) => proxy.label).sort(),
    ['Proxy 1', 'Proxy 7'],
  );
});

test('blocks a reconnect when the assigned proxy is marked offline', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-offline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = writeConfig(directory);
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  raw.profiles['proxy-sp-01'].validationStatus = 'offline';
  fs.writeFileSync(configFile, JSON.stringify(raw));
  fs.chmodSync(configFile, 0o600);
  const registry = new EgressProxyRegistry({ mode: 'assigned', configFile });
  registry.start();

  assert.throws(
    () => registry.resolve(workspaceId),
    (error) =>
      error instanceof EgressProxyError &&
      error.code === 'EGRESS_PROXY_UNAVAILABLE',
  );
});

test('requires three consecutive probe failures before blocking reconnects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-hysteresis-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = writeConfig(directory);
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  raw.profiles['proxy-sp-01'].validationStatus = 'online';
  fs.writeFileSync(configFile, JSON.stringify(raw));
  fs.chmodSync(configFile, 0o600);
  let probeAvailable = false;
  const registry = new EgressProxyRegistry({
    mode: 'assigned',
    configFile,
    probeProxy: async () => {
      if (!probeAvailable) throw new Error('transient probe failure');
      return { exitIp: '203.0.113.10' };
    },
  });
  registry.start();

  await registry.validateProfile('proxy-sp-01');
  await registry.validateProfile('proxy-sp-01');
  assert.equal(registry.getWorkspaceStatus(workspaceId).state, 'online');
  assert.equal(
    registry.getWorkspaceStatus(workspaceId).consecutiveValidationFailures,
    2,
  );
  assert.equal(registry.resolve(workspaceId).id, 'proxy-sp-01');

  await registry.validateProfile('proxy-sp-01');
  assert.equal(registry.getWorkspaceStatus(workspaceId).state, 'offline');
  assert.throws(
    () => registry.resolve(workspaceId),
    (error) =>
      error instanceof EgressProxyError &&
      error.code === 'EGRESS_PROXY_UNAVAILABLE',
  );

  probeAvailable = true;
  await registry.validateProfile('proxy-sp-01');
  assert.equal(registry.getWorkspaceStatus(workspaceId).state, 'online');
  assert.equal(
    registry.getWorkspaceStatus(workspaceId).consecutiveValidationFailures,
    0,
  );
  assert.equal(registry.getWorkspaceStatus(workspaceId).lastValidationErrorAt, null);
});

test('publishes one atomic inventory snapshot after validating all proxies', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-egress-atomic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = writeConfig(directory, {});
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  raw.profiles['proxy-rj-02'] = {
    ...raw.profiles['proxy-sp-01'],
    label: 'Proxy 2',
    url: 'http://cliente:outro-segredo@proxy-2.example.com:8080',
  };
  fs.writeFileSync(configFile, JSON.stringify(raw));
  fs.chmodSync(configFile, 0o600);
  const registry = new EgressProxyRegistry({
    mode: 'assigned',
    configFile,
    probeProxy: async (profile) => ({
      exitIp: profile.id === 'proxy-sp-01' ? '203.0.113.10' : '203.0.113.11',
    }),
  });
  registry.start();
  const persistConfig = registry.writeConfig.bind(registry);
  let writes = 0;
  registry.writeConfig = (next) => {
    writes += 1;
    persistConfig(next);
  };

  const result = await registry.validateAll();

  assert.equal(writes, 1);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((profile) => profile.state),
    ['online', 'online'],
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
