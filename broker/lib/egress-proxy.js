'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const WORKSPACE_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const PROFILE_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);
const SUPPORTED_MODES = new Set(['disabled', 'assigned', 'required']);

class EgressProxyError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.name = 'EgressProxyError';
    this.code = code;
    this.status = status;
  }
}

class EgressProxyRegistry {
  constructor({ mode, configFile }) {
    if (!SUPPORTED_MODES.has(mode)) {
      throw new EgressProxyError(
        'EGRESS_PROXY_MODE_INVALID',
        'WHATSAPP_EGRESS_PROXY_MODE deve ser disabled, assigned ou required',
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
    if (this.mode === 'assigned' && this.configFile && !fs.existsSync(this.configFile)) {
      this.writeConfig({ version: 1, profiles: {}, assignments: {} });
    }
    this.reload(true);
    if (
      this.mode === 'required' &&
      (!this.parsed || this.parsed.assignments.size < 1)
    ) {
      this.lastError = 'config_invalid';
      throw invalidConfig();
    }
  }

  resolve(workspaceId) {
    if (this.mode === 'disabled') return null;
    assertWorkspaceId(workspaceId);
    this.reload(false);
    const assignment = this.parsed && this.parsed.assignments.get(workspaceId);
    if (!assignment && this.mode === 'assigned') return null;
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
    if (profile.expiresAt && Date.parse(profile.expiresAt) <= Date.now()) {
      throw new EgressProxyError(
        'EGRESS_PROXY_EXPIRED',
        'A proxy atribuída está vencida; operação bloqueada',
      );
    }
    if (profile.validationStatus === 'offline') {
      throw new EgressProxyError(
        'EGRESS_PROXY_UNAVAILABLE',
        'A proxy atribuída está offline; operação bloqueada',
      );
    }
    return profile;
  }

  listPublic() {
    if (this.mode === 'disabled') return [];
    this.reload(false);
    const workspaceByProfile = new Map(
      [...this.parsed.assignments.values()].map((assignment) => [
        assignment.profileId,
        assignment.workspaceId,
      ]),
    );
    return [...this.parsed.profiles.values()].map((profile) => ({
      profileId: profile.id,
      label: profile.label,
      assigned: workspaceByProfile.has(profile.id),
      assignedWorkspaceId: workspaceByProfile.get(profile.id) || null,
      state:
        profile.expiresAt && Date.parse(profile.expiresAt) <= Date.now()
          ? 'expired'
          : profile.validationStatus,
      vendor: profile.vendor,
      country: profile.country,
      region: profile.region,
      expiresAt: profile.expiresAt,
      lastValidatedAt: profile.lastValidatedAt,
      validationStatus: profile.validationStatus,
      credentialFingerprint: profile.credentialFingerprint,
    }));
  }

  getWorkspaceStatus(workspaceId) {
    assertWorkspaceId(workspaceId);
    if (this.mode === 'disabled') {
      return { workspaceId, assigned: false, state: 'disabled' };
    }
    this.reload(false);
    const assignment = this.parsed.assignments.get(workspaceId);
    if (!assignment) return { workspaceId, assigned: false, state: 'unassigned' };
    const profile = this.parsed.profiles.get(assignment.profileId);
    if (!profile) {
      return { workspaceId, assigned: true, state: 'invalid' };
    }
    const expired = Boolean(
      profile.expiresAt && Date.parse(profile.expiresAt) <= Date.now(),
    );
    return {
      workspaceId,
      assigned: true,
      state: expired ? 'expired' : profile.validationStatus,
      profileId: profile.id,
      label: profile.label,
      vendor: profile.vendor,
      country: profile.country,
      region: profile.region,
      expiresAt: profile.expiresAt,
      lastValidatedAt: profile.lastValidatedAt,
      validationStatus: profile.validationStatus,
      credentialFingerprint: profile.credentialFingerprint,
    };
  }

  async register(input) {
    if (this.mode === 'disabled') {
      throw new EgressProxyError(
        'EGRESS_PROXY_DISABLED',
        'Gestão de proxy desabilitada no Hub',
        409,
      );
    }
    this.reload(false);
    const profile = await normalizeManagedProfile('proxy-inventory', input);
    const probe = await probeHttpsThroughProxy(profile);
    const now = new Date().toISOString();
    const profileId = profileIdForCredentials(profile);
    const raw = this.toRawConfig();
    raw.profiles[profileId] = {
      label: raw.profiles[profileId]?.label || nextProxyLabel(raw.profiles),
      url: buildProxyUrl(profile),
      vendor: profile.vendor,
      country: profile.country,
      region: profile.region,
      dedicated: true,
      rotation: 'disabled',
      expiresAt: profile.expiresAt,
      lastValidatedAt: now,
      validationStatus: 'online',
      credentialFingerprint: credentialFingerprint(profile),
      exitIpHash: crypto.createHash('sha256').update(probe.exitIp).digest('hex').slice(0, 12),
    };
    this.writeConfig(raw);
    this.reload(true);
    return this.listPublic().find((candidate) => candidate.profileId === profileId);
  }

  async validateAll() {
    if (this.mode === 'disabled') return [];
    this.reload(false);
    const profileIds = [...this.parsed.profiles.keys()];
    const results = [];
    for (const profileId of profileIds) {
      results.push(await this.validateProfile(profileId));
    }
    return results;
  }

  async validateProfile(profileId) {
    if (!PROFILE_PATTERN.test(String(profileId || ''))) throw badInput();
    this.reload(false);
    const profile = this.parsed.profiles.get(profileId);
    if (!profile) {
      throw new EgressProxyError('EGRESS_PROXY_NOT_FOUND', 'Proxy não encontrada', 404);
    }
    let exitIpHash = profile.exitIpHash;
    let validationStatus = 'online';
    try {
      const probe = await probeHttpsThroughProxy(profile);
      exitIpHash = crypto.createHash('sha256').update(probe.exitIp).digest('hex').slice(0, 12);
    } catch (_error) {
      validationStatus = 'offline';
    }
    const raw = this.toRawConfig();
    raw.profiles[profileId] = {
      ...raw.profiles[profileId],
      lastValidatedAt: new Date().toISOString(),
      validationStatus,
      exitIpHash,
    };
    this.writeConfig(raw);
    this.reload(true);
    return this.listPublic().find((candidate) => candidate.profileId === profileId);
  }

  async assign(workspaceId, input) {
    if (this.mode === 'disabled') {
      throw new EgressProxyError(
        'EGRESS_PROXY_DISABLED',
        'Gestão de proxy desabilitada no Hub',
        409,
      );
    }
    assertWorkspaceId(workspaceId);
    this.reload(false);
    if (isRecord(input) && typeof input.profileId === 'string') {
      return this.assignExisting(
        workspaceId,
        input.profileId,
        typeof input.transferFromWorkspaceId === 'string'
          ? input.transferFromWorkspaceId
          : null,
      );
    }
    const profile = await normalizeManagedProfile(workspaceId, input);
    const probe = await probeHttpsThroughProxy(profile);
    const now = new Date().toISOString();
    const stored = {
      label: null,
      url: buildProxyUrl(profile),
      vendor: profile.vendor,
      country: profile.country,
      region: profile.region,
      dedicated: true,
      rotation: 'disabled',
      expiresAt: profile.expiresAt,
      lastValidatedAt: now,
      validationStatus: 'online',
      credentialFingerprint: credentialFingerprint(profile),
      exitIpHash: crypto.createHash('sha256').update(probe.exitIp).digest('hex').slice(0, 12),
    };
    const raw = this.toRawConfig();
    const profileId = profileIdForCredentials(profile);
    stored.label = raw.profiles[profileId]?.label || nextProxyLabel(raw.profiles);
    const assignedWorkspaceId = Object.entries(raw.assignments).find(
      ([candidateWorkspaceId, candidateProfileId]) =>
        candidateProfileId === profileId && candidateWorkspaceId !== workspaceId,
    )?.[0];
    if (assignedWorkspaceId) {
      const transferFromWorkspaceId = String(input.transferFromWorkspaceId || '');
      if (transferFromWorkspaceId !== assignedWorkspaceId) {
        throw new EgressProxyError(
          'EGRESS_PROXY_ALREADY_ASSIGNED',
          'Esta proxy já está atribuída a outro workspace; confirme a transferência',
          409,
        );
      }
      delete raw.assignments[assignedWorkspaceId];
    }
    raw.profiles[profileId] = stored;
    raw.assignments[workspaceId] = profileId;
    this.writeConfig(raw);
    this.reload(true);
    return this.getWorkspaceStatus(workspaceId);
  }

  async assignExisting(workspaceId, profileId, transferFromWorkspaceId = null) {
    assertWorkspaceId(workspaceId);
    if (!PROFILE_PATTERN.test(String(profileId || ''))) throw badInput();
    this.reload(false);
    const raw = this.toRawConfig();
    if (!raw.profiles[profileId]) {
      throw new EgressProxyError('EGRESS_PROXY_NOT_FOUND', 'Proxy não encontrada', 404);
    }
    const profile = this.parsed.profiles.get(profileId);
    const probe = await probeHttpsThroughProxy(profile);
    const assignedWorkspaceId = Object.entries(raw.assignments).find(
      ([candidateWorkspaceId, candidateProfileId]) =>
        candidateProfileId === profileId && candidateWorkspaceId !== workspaceId,
    )?.[0];
    if (assignedWorkspaceId && transferFromWorkspaceId !== assignedWorkspaceId) {
      throw new EgressProxyError(
        'EGRESS_PROXY_ALREADY_ASSIGNED',
        'Esta proxy já está atribuída a outro workspace; confirme a transferência',
        409,
      );
    }
    if (assignedWorkspaceId) delete raw.assignments[assignedWorkspaceId];
    raw.profiles[profileId] = {
      ...raw.profiles[profileId],
      lastValidatedAt: new Date().toISOString(),
      validationStatus: 'online',
      exitIpHash: crypto
        .createHash('sha256')
        .update(probe.exitIp)
        .digest('hex')
        .slice(0, 12),
    };
    raw.assignments[workspaceId] = profileId;
    this.writeConfig(raw);
    this.reload(true);
    return this.getWorkspaceStatus(workspaceId);
  }

  remove(workspaceId) {
    if (this.mode === 'disabled') {
      throw new EgressProxyError(
        'EGRESS_PROXY_DISABLED',
        'Gestão de proxy desabilitada no Hub',
        409,
      );
    }
    assertWorkspaceId(workspaceId);
    this.reload(false);
    const raw = this.toRawConfig();
    const profileId = raw.assignments[workspaceId];
    if (!profileId) return { workspaceId, assigned: false, state: 'unassigned' };
    delete raw.assignments[workspaceId];
    this.writeConfig(raw);
    this.reload(true);
    return { workspaceId, assigned: false, state: 'unassigned' };
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
        'Arquivo de proxies precisa estar restrito ao usuário do broker; operação bloqueada',
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

  toRawConfig() {
    const profiles = {};
    const assignments = {};
    for (const profile of this.parsed.profiles.values()) {
      profiles[profile.id] = {
        label: profile.label,
        url: buildProxyUrl(profile),
        vendor: profile.vendor,
        country: profile.country,
        region: profile.region,
        dedicated: true,
        rotation: 'disabled',
        expiresAt: profile.expiresAt,
        lastValidatedAt: profile.lastValidatedAt,
        validationStatus: profile.validationStatus,
        credentialFingerprint: profile.credentialFingerprint,
        exitIpHash: profile.exitIpHash,
      };
    }
    for (const assignment of this.parsed.assignments.values()) {
      assignments[assignment.workspaceId] = assignment.profileId;
    }
    return { version: 1, profiles, assignments };
  }

  writeConfig(raw) {
    if (!this.configFile) {
      throw new EgressProxyError(
        'EGRESS_PROXY_CONFIG_MISSING',
        'Arquivo de proxies não configurado; operação bloqueada',
      );
    }
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
    const temporary = `${this.configFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.configFile);
      fs.chmodSync(this.configFile, 0o600);
    } finally {
      try { fs.unlinkSync(temporary); } catch (_error) { /* arquivo já promovido */ }
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
      label:
        typeof value.label === 'string' && value.label.trim()
          ? value.label.trim().slice(0, 80)
          : null,
      vendor,
      country,
      region,
      protocol: url.protocol.slice(0, -1),
      host: url.hostname,
      port: url.port,
      server: `${url.hostname}:${url.port}`,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      expiresAt: optionalIso(value.expiresAt),
      lastValidatedAt: optionalIso(value.lastValidatedAt),
      validationStatus: ['online', 'offline'].includes(value.validationStatus)
        ? value.validationStatus
        : 'pending',
      credentialFingerprint:
        typeof value.credentialFingerprint === 'string'
          ? value.credentialFingerprint.slice(0, 16)
          : credentialFingerprint({
              protocol: url.protocol.slice(0, -1),
              host: url.hostname,
              port: url.port,
              username: decodeURIComponent(url.username),
              password: decodeURIComponent(url.password),
            }),
      exitIpHash: typeof value.exitIpHash === 'string' ? value.exitIpHash.slice(0, 16) : null,
    });
  }

  const usedLabels = new Set();
  for (const profile of [...profiles.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (profile.label) {
      if (usedLabels.has(profile.label)) throw invalidConfig();
      usedLabels.add(profile.label);
      continue;
    }
    profile.label = nextProxyLabelFromSet(usedLabels);
    usedLabels.add(profile.label);
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

  const publicShape = {
    profiles: [...profiles.values()].map(({ id, label, vendor, country, region, credentialFingerprint }) => ({
      id,
      label,
      vendor,
      country,
      region,
      credentialFingerprint,
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

async function normalizeManagedProfile(workspaceId, input) {
  if (!isRecord(input)) throw badInput();
  const protocol = String(input.protocol || '').trim().toLowerCase().replace(/:$/, '');
  const host = String(input.host || '').trim().toLowerCase();
  const port = String(input.port || '').trim();
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  const vendor = String(input.vendor || '').trim();
  const country = String(input.country || 'BR').trim().toUpperCase();
  const region = String(input.region || '').trim().toUpperCase() || null;
  const expiresAt = optionalIso(input.expiresAt);
  if (
    !['http', 'https'].includes(protocol) ||
    !host || host.length > 253 || /[\s/@]/.test(host) ||
    !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
    !username || username.length > 256 ||
    !password || password.length > 512 ||
    !vendor || vendor.length > 80 ||
    !/^[A-Z]{2}$/.test(country) ||
    (region && region.length > 64) ||
    (input.expiresAt && !expiresAt)
  ) {
    throw badInput();
  }
  await assertPublicProxyHost(host);
  return { workspaceId, protocol, host, port, username, password, vendor, country, region, expiresAt };
}

async function assertPublicProxyHost(host) {
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch (_error) {
    throw new EgressProxyError('EGRESS_PROXY_HOST_INVALID', 'Host do proxy não pôde ser resolvido', 400);
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new EgressProxyError('EGRESS_PROXY_HOST_PRIVATE', 'Host privado ou local não é permitido', 400);
  }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    return (
      octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
    );
  }
  const normalized = address.toLowerCase();
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd');
}

function probeHttpsThroughProxy(profile) {
  return new Promise((resolve, reject) => {
    const client = profile.protocol === 'https' ? https : http;
    const request = client.request({
      host: profile.host,
      port: Number(profile.port),
      method: 'CONNECT',
      path: 'api64.ipify.org:443',
      headers: {
        Host: 'api64.ipify.org:443',
        'Proxy-Authorization': `Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString('base64')}`,
      },
      timeout: 10_000,
    });
    request.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return reject(proxyUnavailable());
      }
      const secure = tls.connect({ socket, servername: 'api64.ipify.org', timeout: 10_000 });
      let responseBody = '';
      secure.setEncoding('utf8');
      secure.once('secureConnect', () => {
        secure.write('GET / HTTP/1.1\r\nHost: api64.ipify.org\r\nConnection: close\r\n\r\n');
      });
      secure.on('data', (chunk) => { responseBody += chunk; });
      secure.once('end', () => {
        const body = responseBody.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        if (!/ 200 /.test(responseBody.slice(0, 64)) || !net.isIP(body)) {
          return reject(proxyUnavailable());
        }
        resolve({ exitIp: body });
      });
      secure.once('error', () => reject(proxyUnavailable()));
      secure.once('timeout', () => {
        secure.destroy();
        reject(proxyUnavailable());
      });
    });
    request.once('timeout', () => {
      request.destroy();
      reject(proxyUnavailable());
    });
    request.once('error', () => reject(proxyUnavailable()));
    request.end();
  });
}

function buildProxyUrl(profile) {
  return `${profile.protocol}://${encodeURIComponent(profile.username)}:${encodeURIComponent(profile.password)}@${profile.host}:${profile.port}`;
}

function credentialFingerprint(profile) {
  return crypto
    .createHash('sha256')
    .update([profile.protocol, profile.host, profile.port, profile.username, profile.password].join('\0'))
    .digest('hex')
    .slice(0, 16);
}

function profileIdForCredentials(profile) {
  return `proxy-${credentialFingerprint(profile)}`;
}

function nextProxyLabel(profiles) {
  return nextProxyLabelFromSet(
    new Set(
      Object.values(profiles)
        .map((profile) => (isRecord(profile) ? String(profile.label || '').trim() : ''))
        .filter(Boolean),
    ),
  );
}

function nextProxyLabelFromSet(usedLabels) {
  let number = 1;
  while (usedLabels.has(`Proxy ${number}`)) number += 1;
  return `Proxy ${number}`;
}

function optionalIso(value) {
  if (value == null || value === '') return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function assertWorkspaceId(workspaceId) {
  if (!WORKSPACE_PATTERN.test(String(workspaceId || ''))) {
    throw new EgressProxyError('EGRESS_PROXY_WORKSPACE_INVALID', 'Workspace inválido', 400);
  }
}

function createEgressProxyRegistry(env = process.env) {
  const mode = String(env.WHATSAPP_EGRESS_PROXY_MODE || 'disabled').trim().toLowerCase();
  const configDir = String(env.BROKER_CONFIG_DIR || '/config').trim() || '/config';
  return new EgressProxyRegistry({
    mode,
    configFile:
      String(env.WHATSAPP_EGRESS_PROXY_CONFIG_FILE || '').trim() ||
      (mode === 'assigned' ? path.join(configDir, 'egress-proxies.json') : null),
  });
}

function invalidConfig() {
  return new EgressProxyError(
    'EGRESS_PROXY_CONFIG_INVALID',
    'Arquivo de proxies inválido; operação bloqueada',
  );
}

function badInput() {
  return new EgressProxyError('EGRESS_PROXY_INPUT_INVALID', 'Dados do proxy inválidos', 400);
}

function proxyUnavailable() {
  return new EgressProxyError(
    'EGRESS_PROXY_UNAVAILABLE',
    'O proxy não confirmou conexão HTTPS; nenhum dado foi salvo',
    422,
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
  probeHttpsThroughProxy,
};
