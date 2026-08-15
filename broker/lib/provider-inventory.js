'use strict';

const fs = require('fs');
const path = require('path');

const WAHA_RELEASES_URL = 'https://api.github.com/repos/devlikeapro/waha/releases/latest';
const EVOLUTION_RELEASES_URL = 'https://api.github.com/repos/evolution-foundation/evolution-api/releases/latest';
const LATEST_CACHE_MS = 30 * 60 * 1000;
let wahaLatestCache = null;
let evolutionLatestCache = null;

async function buildProviderInventory({ registry, env = process.env, fetchImpl = fetch, now = new Date() }) {
  const generatedAt = now.toISOString();
  const configDir = env.BROKER_CONFIG_DIR || path.join(__dirname, '..');
  const releaseState = readProviderReleaseState(configDir);
  const [baileys, waha, evolution] = await Promise.all([
    buildBaileysProvider(registry.mentorian, generatedAt),
    buildWahaProvider(registry.waha, env, fetchImpl, generatedAt, releaseState.waha),
    buildEvolutionProvider(registry.evolution, env, fetchImpl, generatedAt, releaseState.evolution),
  ]);
  const providers = [baileys, waha, evolution];
  persistObservedVersions(providers, configDir, generatedAt);
  const history = readVersionHistory(configDir);

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

async function buildEvolutionProvider(entry, env, fetchImpl, generatedAt, releaseState = null) {
  let readiness = null;
  try {
    readiness = entry && typeof entry.adapter.readiness === 'function'
      ? await entry.adapter.readiness(entry.ctx)
      : null;
  } catch (_error) {
    readiness = null;
  }
  const installedVersion = String(
    releaseState?.installedVersion || env.EVOLUTION_VERSION || env.EVO_VERSION || '2.3.7',
  ).replace(/^v/, '');
  const official = await readLatestEvolutionVersion({ env, fetchImpl, now: new Date(generatedAt) });
  const latestVersion = official.version;
  const status = !latestVersion
    ? 'check_failed'
    : latestVersion === installedVersion
      ? 'up_to_date'
      : 'update_available';
  return {
    id: 'evolution',
    name: 'Evolution API',
    family: 'Evolution / Baileys',
    online: readiness?.ok === true,
    readyForUse: true,
    deployment: 'Docker VPS',
    gatewayVersion: readiness?.version || `v${installedVersion}`,
    package: {
      installedVersion,
      latestVersion,
      status,
      releaseChannel: String(releaseState?.releaseChannel || env.EVOLUTION_RELEASE_CHANNEL || 'stable'),
      prerelease: false,
      // Only persisted updater state proves that the VPS timer executed.
      automaticUpdates: releaseState?.automaticUpdates === true,
      lastCheckedAt: official.checkedAt,
      lastUpdatedAt: String(releaseState?.lastUpdatedAt || env.EVOLUTION_UPDATED_AT || generatedAt),
      lastUpdateSource: String(releaseState?.lastUpdateSource || 'release'),
      lastCheckError: official.error,
      history: [],
    },
    protocol: {
      version: readiness?.protocolVersion || readiness?.version || `v${installedVersion}`,
      lastCheckedAt: generatedAt,
      refreshPolicy: 'provider_managed',
    },
    checkedAt: generatedAt,
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

async function buildWahaProvider(entry, env, fetchImpl, generatedAt, releaseState = null) {
  let readiness = null;
  try {
    readiness = entry && typeof entry.adapter.readiness === 'function'
      ? await entry.adapter.readiness(entry.ctx)
      : null;
  } catch (_error) {
    readiness = null;
  }
  const installedVersion = String(releaseState?.installedVersion || env.WAHA_VERSION || '2026.7.2').replace(/^v/, '');
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
      releaseChannel: String(releaseState?.releaseChannel || env.WAHA_RELEASE_CHANNEL || 'stable'),
      prerelease: false,
      // Environment intent is not operational proof; the updater writes this
      // state after a successful protected verification.
      automaticUpdates: releaseState?.automaticUpdates === true,
      lastCheckedAt: official.checkedAt,
      lastUpdatedAt: String(releaseState?.lastUpdatedAt || env.WAHA_UPDATED_AT || generatedAt),
      lastUpdateSource: String(releaseState?.lastUpdateSource || 'release'),
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
    const version = response.ok && body && body.draft !== true && body.prerelease !== true && typeof body.tag_name === 'string'
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

async function readLatestEvolutionVersion({ env, fetchImpl, now }) {
  const forced = String(env.EVOLUTION_LATEST_VERSION || '').trim().replace(/^v/, '');
  if (forced) return { version: forced, checkedAt: now.toISOString(), error: null };
  if (evolutionLatestCache && now.getTime() - evolutionLatestCache.timestamp < LATEST_CACHE_MS) {
    return evolutionLatestCache.value;
  }
  const value = await readOfficialStableVersion({
    url: env.EVOLUTION_RELEASES_URL || EVOLUTION_RELEASES_URL,
    fetchImpl,
    now,
    versionPattern: /^\d+\.\d+\.\d+$/,
  });
  evolutionLatestCache = { timestamp: now.getTime(), value };
  return value;
}

async function readOfficialStableVersion({ url, fetchImpl, now, versionPattern }) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Mentorian-WAHub' },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json().catch(() => null);
    const candidate = response.ok && body && body.draft !== true && body.prerelease !== true && typeof body.tag_name === 'string'
      ? body.tag_name.trim().replace(/^v/, '')
      : '';
    const version = versionPattern.test(candidate) ? candidate : '';
    return version
      ? { version, checkedAt: now.toISOString(), error: null }
      : { version: null, checkedAt: now.toISOString(), error: 'official_registry_unavailable' };
  } catch (_error) {
    return { version: null, checkedAt: now.toISOString(), error: 'official_registry_unavailable' };
  }
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

function readProviderReleaseState(configDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, 'provider-release-state.json'), 'utf8'));
    return parsed && parsed.version === 1 && parsed.providers && typeof parsed.providers === 'object'
      ? parsed.providers
      : {};
  } catch (_error) {
    return {};
  }
}

function resetLatestCacheForTests() {
  wahaLatestCache = null;
  evolutionLatestCache = null;
}

module.exports = {
  buildProviderInventory,
  readLatestWahaVersion,
  readLatestEvolutionVersion,
  resetLatestCacheForTests,
};
