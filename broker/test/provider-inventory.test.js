'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildProviderInventory,
  resetLatestCacheForTests,
} = require('../lib/provider-inventory');

test('returns the three Mentorian-approved providers with isolated health', async () => {
  resetLatestCacheForTests();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-provider-inventory-'));
  const registry = {
    mentorian: {
      ctx: {},
      adapter: {
        readiness: async () => ({
          ok: true,
          runtime: {
            gatewayVersion: '1.2.3',
            package: {
              installedVersion: '7.0.0-rc14',
              latestVersion: '7.0.0-rc14',
              status: 'up_to_date',
              automaticUpdates: true,
              lastUpdatedAt: '2026-08-01T00:00:00.000Z',
              lastUpdateSource: 'automatic',
              history: [],
            },
            protocol: { version: '2.3000', lastCheckedAt: null },
          },
        }),
      },
    },
    waha: {
      ctx: {},
      adapter: { readiness: async () => ({ ok: true, engine: 'NOWEB' }) },
    },
    evolution: {
      ctx: {},
      adapter: { readiness: async () => ({ ok: true, version: 'v2.3.7' }) },
    },
  };
  const inventory = await buildProviderInventory({
    registry,
    env: {
      BROKER_CONFIG_DIR: configDir,
      WAHA_VERSION: '2026.7.1',
      EVOLUTION_VERSION: '2.3.7',
    },
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({
        tag_name: String(url).includes('evolution-foundation') ? '2.3.7' : '2026.7.1',
        draft: false,
        prerelease: false,
      }),
    }),
    now: new Date('2026-08-13T12:00:00.000Z'),
  });

  assert.deepEqual(inventory.providers.map((provider) => provider.id), ['baileys', 'waha', 'evolution']);
  assert.equal(inventory.ok, true);
  assert.equal(inventory.providers[0].package.automaticUpdates, true);
  assert.equal(inventory.providers[1].package.status, 'up_to_date');
  assert.equal(inventory.providers[1].package.automaticUpdates, false);
  assert.equal(inventory.providers[1].package.history[0].version, '2026.7.1');
  assert.equal(inventory.providers[2].package.status, 'up_to_date');
});

test('uses the protected stable auto-update state persisted by the VPS updater', async () => {
  resetLatestCacheForTests();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-provider-release-state-'));
  fs.writeFileSync(path.join(configDir, 'provider-release-state.json'), JSON.stringify({
    version: 1,
    providers: {
      waha: {
        installedVersion: '2026.7.2',
        releaseChannel: 'stable',
        automaticUpdates: true,
        lastUpdatedAt: '2026-08-13T18:00:00.000Z',
        lastUpdateSource: 'automatic',
      },
      evolution: {
        installedVersion: '2.3.7',
        releaseChannel: 'stable',
        automaticUpdates: true,
        lastUpdatedAt: '2026-08-13T18:00:00.000Z',
        lastUpdateSource: 'automatic',
      },
    },
  }));
  const inventory = await buildProviderInventory({
    registry: {
      mentorian: { ctx: {}, adapter: { readiness: async () => ({ ok: true }) } },
      waha: { ctx: {}, adapter: { readiness: async () => ({ ok: true, engine: 'NOWEB' }) } },
      evolution: { ctx: {}, adapter: { readiness: async () => ({ ok: true, version: 'v2.3.7' }) } },
    },
    env: { BROKER_CONFIG_DIR: configDir, WAHA_VERSION: '2026.7.1', EVOLUTION_VERSION: '2.3.7' },
    fetchImpl: async (url) => ({ ok: true, json: async () => ({ tag_name: String(url).includes('evolution-foundation') ? '2.3.7' : '2026.7.2', draft: false, prerelease: false }) }),
    now: new Date('2026-08-13T19:00:00.000Z'),
  });
  const waha = inventory.providers.find((provider) => provider.id === 'waha');
  assert.equal(waha.package.installedVersion, '2026.7.2');
  assert.equal(waha.package.releaseChannel, 'stable');
  assert.equal(waha.package.automaticUpdates, true);
  assert.equal(waha.package.status, 'up_to_date');
  assert.equal(waha.package.lastUpdateSource, 'automatic');
  const evolution = inventory.providers.find((provider) => provider.id === 'evolution');
  assert.equal(evolution.package.automaticUpdates, true);
  assert.equal(evolution.package.status, 'up_to_date');
});

test('rejects a prerelease from the official release feed', async () => {
  resetLatestCacheForTests();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-provider-prerelease-'));
  const inventory = await buildProviderInventory({
    registry: {
      mentorian: { ctx: {}, adapter: { readiness: async () => ({ ok: true }) } },
      waha: { ctx: {}, adapter: { readiness: async () => ({ ok: true, engine: 'NOWEB' }) } },
      evolution: { ctx: {}, adapter: { readiness: async () => ({ ok: true, version: 'v2.3.7' }) } },
    },
    env: { BROKER_CONFIG_DIR: configDir, WAHA_VERSION: '2026.7.1', EVOLUTION_LATEST_VERSION: '2.3.7' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: '2026.8.0-beta.1', draft: false, prerelease: true }) }),
    now: new Date('2026-08-13T19:00:00.000Z'),
  });
  const waha = inventory.providers.find((provider) => provider.id === 'waha');
  assert.equal(waha.package.latestVersion, null);
  assert.equal(waha.package.status, 'check_failed');
});

test('keeps one provider failure from hiding the healthy provider', async () => {
  resetLatestCacheForTests();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wahub-provider-isolation-'));
  const inventory = await buildProviderInventory({
    registry: {
      mentorian: { ctx: {}, adapter: { readiness: async () => { throw new Error('offline'); } } },
      waha: { ctx: {}, adapter: { readiness: async () => ({ ok: true, engine: 'NOWEB' }) } },
      evolution: { ctx: {}, adapter: { readiness: async () => ({ ok: true, version: 'v2.3.7' }) } },
    },
    env: { BROKER_CONFIG_DIR: configDir, WAHA_VERSION: '2026.7.1', EVOLUTION_LATEST_VERSION: '2.3.7' },
    fetchImpl: async () => ({ ok: false, json: async () => null }),
    now: new Date('2026-08-13T12:00:00.000Z'),
  });

  assert.equal(inventory.ok, false);
  assert.equal(inventory.providers[0].online, false);
  assert.equal(inventory.providers[1].online, true);
  assert.equal(inventory.providers[1].package.status, 'check_failed');
});
