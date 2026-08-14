'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const WORKSPACE_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const PROFILE_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

class EgressProxyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EgressProxyError';
    this.code = code;
    this.status = 503;
  }
}

class EgressProxyRegistry {
  constructor({ mode, configFile }) {
    if (mode !== 'disabled' && mode !== 'required') {
      throw new EgressProxyError(
        'EGRESS_PROXY_MODE_INVALID',
        'WHATSAPP_EGRESS_PROXY_MODE deve ser disabled ou required',
      );
    }
    this.mode = mode;
    this.configFile = configFile || null;
    this.parsed = null;
    this.lastModifiedMs = null;
    this.lastLoadedAt = null;
    this.lastError = null;
  }

  start() {
    if (this.mode === 'disabled') return;
    this.reload(true);
  }

  resolve(workspaceId) {
    if (this.mode === 'disabled') return null;
    this.reload(false);
    const assignment = this.parsed && this.parsed.assignments.get(workspaceId);
    if (!assignment) {
      throw new EgressProxyError(
        'EGRESS_PROXY_ASSIGNMENT_MISSING',
        'Workspace sem proxy de saída dedicado; operação bloqueada',
      );
    }
    const profile = this.parsed.profiles.get(assignment.profileId);
    if (!profile) {
      throw new EgressProxyError(
        'EGRESS_PROXY_CONFIG_INVALID',
        'Perfil de proxy atribuído não existe; operação bloqueada',
      );
    }
    return profile;
  }

  getStatus() {
    if (this.mode === 'disabled') {
      return {
        mode: 'disabled',
        ready: true,
        configured: false,
        profileCount: 0,
        assignmentCount: 0,
        configFingerprint: null,
        lastLoadedAt: null,
        error: null,
      };
    }
    try {
      this.reload(false);
    } catch (_error) {
      // O status público informa somente a classe do erro, nunca credenciais.
    }
    return {
      mode: this.mode,
      ready: Boolean(this.parsed) && this.lastError === null,
      configured: Boolean(this.parsed),
      profileCount: this.parsed ? this.parsed.profiles.size : 0,
      assignmentCount: this.parsed ? this.parsed.assignments.size : 0,
      configFingerprint: this.parsed ? this.parsed.fingerprint : null,
      lastLoadedAt: this.lastLoadedAt,
      error: this.lastError,
    };
  }

  reload(force) {
    if (!this.configFile) {
      this.lastError = 'config_missing';
      throw new EgressProxyError(
        'EGRESS_PROXY_CONFIG_MISSING',
        'Arquivo de proxies não configurado; operação bloqueada',
      );
    }
    let metadata;
    try {
      metadata = fs.statSync(this.configFile);
    } catch (_error) {
      this.lastError = 'config_missing';
      throw new EgressProxyError(
        'EGRESS_PROXY_CONFIG_MISSING',
        'Arquivo de proxies não encontrado; operação bloqueada',
      );
    }
    if ((metadata.mode & 0o007) !== 0 || (metadata.mode & 0o022) !== 0) {
      this.lastError = 'config_invalid';
      throw new EgressProxyError(
        'EGRESS_PROXY_CONFIG_INVALID',
        'Arquivo de proxies precisa estar restrito a owner/grupo e sem escrita por grupo; operação bloqueada',
      );
    }
    if (!force && this.parsed && metadata.mtimeMs === this.lastModifiedMs) return;

    try {
      this.parsed = parseProxyConfig(fs.readFileSync(this.configFile, 'utf8'));
      this.lastModifiedMs = metadata.mtimeMs;
      this.lastLoadedAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.parsed = null;
      this.lastModifiedMs = null;
      this.lastError = 'config_invalid';
      if (error instanceof EgressProxyError) throw error;
      throw invalidConfig();
    }
  }
}

function parseProxyConfig(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (_error) {
    throw invalidConfig();
  }
  if (!isRecord(input) || input.version !== 1) throw invalidConfig();
  if (!isRecord(input.profiles) || !isRecord(input.assignments)) throw invalidConfig();

  const profiles = new Map();
  for (const [id, value] of Object.entries(input.profiles)) {
    if (!PROFILE_PATTERN.test(id) || !isRecord(value)) throw invalidConfig();
    if (
      typeof value.url !== 'string' ||
      typeof value.vendor !== 'string' ||
      typeof value.country !== 'string' ||
      value.dedicated !== true ||
      value.rotation !== 'disabled'
    ) {
      throw invalidConfig();
    }
    let url;
    try {
      url = new URL(value.url);
    } catch (_error) {
      throw invalidConfig();
    }
    if (
      !SUPPORTED_PROTOCOLS.has(url.protocol) ||
      !url.hostname ||
      !url.port ||
      !url.username ||
      !url.password ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      throw invalidConfig();
    }
    const vendor = value.vendor.trim();
    const country = value.country.trim().toUpperCase();
    const region = typeof value.region === 'string' && value.region.trim()
      ? value.region.trim().toUpperCase()
      : null;
    if (!vendor || !/^[A-Z]{2}$/.test(country)) throw invalidConfig();
    profiles.set(id, {
      id,
      vendor,
      country,
      region,
      protocol: url.protocol.slice(0, -1),
      host: url.hostname,
      port: url.port,
      server: `${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
  }

  const assignments = new Map();
  const usedProfiles = new Set();
  for (const [workspaceId, profileId] of Object.entries(input.assignments)) {
    if (
      !WORKSPACE_PATTERN.test(workspaceId) ||
      typeof profileId !== 'string' ||
      !profiles.has(profileId) ||
      usedProfiles.has(profileId)
    ) {
      throw invalidConfig();
    }
    usedProfiles.add(profileId);
    assignments.set(workspaceId, { workspaceId, profileId });
  }
  if (profiles.size < 1 || assignments.size < 1) throw invalidConfig();

  const publicShape = {
    profiles: [...profiles.values()].map(({ id, vendor, country, region }) => ({
      id,
      vendor,
      country,
      region,
    })),
    assignments: [...assignments.values()],
  };
  return {
    profiles,
    assignments,
    fingerprint: crypto
      .createHash('sha256')
      .update(JSON.stringify(publicShape))
      .digest('hex')
      .slice(0, 12),
  };
}

function createEgressProxyRegistry(env = process.env) {
  return new EgressProxyRegistry({
    mode: String(env.WHATSAPP_EGRESS_PROXY_MODE || 'disabled').trim().toLowerCase(),
    configFile: String(env.WHATSAPP_EGRESS_PROXY_CONFIG_FILE || '').trim() || null,
  });
}

function invalidConfig() {
  return new EgressProxyError(
    'EGRESS_PROXY_CONFIG_INVALID',
    'Arquivo de proxies inválido; operação bloqueada',
  );
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  EgressProxyError,
  EgressProxyRegistry,
  createEgressProxyRegistry,
  parseProxyConfig,
};
