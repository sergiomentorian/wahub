'use strict';

const fs = require('fs');
const path = require('path');

const WAHA_RELEASES_URL = 'https://api.github.com/repos/devlikeapro/waha/releases/latest';
const LATEST_CACHE_MS = 30 * 60 * 1000;
let wahaLatestCache = null;

async function buildProviderInventory({ registry, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const generatedAt = now.toISOString();
  const [baileys, waha] = await Promise.all([
    buildBaileysProvider(registry.mentorian, generatedAt),
    buildWahaProvider(registry.waha, env, fetchImpl, generatedAt),
  ]);
  const providers = [baileys, waha];
  persistObservedVersions(providers, env.BROKER_CONFIG_DIR || path.join(__dirname, '..'), generatedAt);
  const history = readVersionHistory(env.BROKER_CONFIG_DIR || path.join(__dirname, '..'));

  return {
    ok: providers.every((provider) => provider.online),
    generatedAt,
    providers: providers.map((provider) => ({
      ...provider,
      package: provider.package
        ? { ...provider.package, history: history[provider.id] || provider.package.history || [] }
        : null,
    })),
  };
}

async function buildBaileysProvider(entry, generatedAt) {
  let readiness = null;
  try {
    readiness = entry && typeof entry.adapter.readiness === 'function'
      ? await entry.adapter.readiness(entry.ctx)
      : null;
  } catch (_error) {
    readiness = null;
  }
  const runtime = readiness && readiness.runtime;
  const packageStatus = runtime && runtime.package;
  return {
    id: 'baileys',
    name: 'Baileys',
    family: 'Baileys nativo',
    online: readiness?.ok === true,
    readyForUse: true,
    deployment: 'Docker VPS',
    gatewayVersion: runtime && runtime.gatewayVersion || null,
    package: packageStatus ? { ...packageStatus, history: packageStatus.history || [] } : null,
    protocol: runtime && runtime.protocol || null,
    checkedAt: generatedAt,
  };
}

async function buildWahaProvider(entry, env, fetchImpl, generatedAt) {
  let readiness = null;
  try {
    readiness = entry && typeof entry.adapter.readiness === 'function'
      ? await entry.adapter.readiness(entry.ctx)
      : null;
  } catch (_error) {
    readiness = null;
  }
  const installedVersion = String(env.WAHA_VERSION || '2026.7.1').replace(/^v/, '');
  const official = await readLatestWahaVersion({ env, fetchImpl, now: new Date(generatedAt) });
  const latestVersion = official.version;
  const status = !latestVersion
    ? 'check_failed'
    : latestVersion === installedVersion
      ? 'up_to_date'
      : 'update_available';
  return {
    id: 'waha',
    name: 'WAHA',
    family: 'WAHA NOWEB',
    online: readiness?.ok === true,
    readyForUse: true,
    deployment: 'Docker VPS',
    gatewayVersion: readiness && readiness.engine ? `NOWEB / ${readiness.engine}` : 'NOWEB',
    package: {
      installedVersion,
      latestVersion,
      status,
      releaseChannel: 'pinned',
      prerelease: false,
      automaticUpdates: env.WAHA_AUTOMATIC_UPDATES === 'true',
      lastCheckedAt: official.checkedAt,
      lastUpdatedAt: String(env.WAHA_UPDATED_AT || generatedAt),
      lastUpdateSource: 'release',
      lastCheckError: official.error,
      history: [],
    },
    protocol: {
      version: readiness && readiness.engine || 'NOWEB',
      lastCheckedAt: generatedAt,
      refreshPolicy: 'provider_managed',
    },
    checkedAt: generatedAt,
  };
}

async function readLatestWahaVersion({ env, fetchImpl, now }) {
  const forced = String(env.WAHA_LATEST_VERSION || '').trim().replace(/^v/, '');
  if (forced) return { version: forced, checkedAt: now.toISOString(), error: null };
  if (wahaLatestCache && now.getTime() - wahaLatestCache.timestamp < LATEST_CACHE_MS) {
    return wahaLatestCache.value;
  }
  let value;
  try {
    const response = await fetchImpl(env.WAHA_RELEASES_URL || WAHA_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mentorian-WAHub' },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => null);
    const version = response.ok && body && typeof body.tag_name === 'string'
      ? body.tag_name.trim().replace(/^v/, '')
      : '';
    value = version
      ? { version, checkedAt: now.toISOString(), error: null }
      : { version: null, checkedAt: now.toISOString(), error: 'official_registry_unavailable' };
  } catch (_error) {
    value = { version: null, checkedAt: now.toISOString(), error: 'official_registry_unavailable' };
  }
  wahaLatestCache = { timestamp: now.getTime(), value };
  return value;
}

function persistObservedVersions(providers, configDir, observedAt) {
  const history = readVersionHistory(configDir);
  let changed = false;
  for (const provider of providers) {
    const version = provider.package && provider.package.installedVersion;
    if (!version) continue;
    const entries = history[provider.id] || [];
    if (entries[0] && entries[0].version === version) continue;
    history[provider.id] = [{
      version,
      previousVersion: entries[0] && entries[0].version || null,
      installedAt: provider.package.lastUpdatedAt || observedAt,
      source: provider.package.lastUpdateSource || 'release',
    }, ...entries].slice(0, 20);
    changed = true;
  }
  if (!changed) return;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(historyFile(configDir), JSON.stringify({ version: 1, providers: history }, null, 2), { mode: 0o600 });
  } catch (_error) {
    // O inventário continua disponível mesmo se o volume de histórico estiver somente leitura.
  }
}

function readVersionHistory(configDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile(configDir), 'utf8'));
    return parsed && parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {};
  } catch (_error) {
    return {};
  }
}

function historyFile(configDir) {
  return path.join(configDir, 'provider-version-history.json');
}

function resetLatestCacheForTests() {
  wahaLatestCache = null;
}

module.exports = { buildProviderInventory, readLatestWahaVersion, resetLatestCacheForTests };
