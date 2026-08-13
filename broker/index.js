'use strict';

/**
 * index.js — servidor HTTP do broker do hub.
 *
 * Monta um REGISTRY de adapters (Evolution,
 * EvoGo, WuzAPI, WAHA, UAZAPI), expõe a lista unificada de sessões, proxy de QR,
 * import/export de passaporte e a migração 1-clique (/migrate).
 *
 * ── Segurança ─────────────────────────────────────────────────────────────────
 *  - Todas as rotas de DADOS exigem `x-hub-secret` (HUB_SECRET, comparação em tempo
 *    constante via util.requireSecret). `GET /health` e, quando explicitamente
 *    habilitada, a UI estática (`GET /`) são públicas (mesma origem). Na instalação
 *    Mentorian a UI fica desligada e o middleware de secret protege as rotas de dados.
 *
 * ── Anti-colisão ───────────────────────────────────────────────────────────────
 *  - O registry é keyed por id EXATO do adapter (evogo != evo). Nunca String.includes.
 *
 * ── Boot resiliente ────────────────────────────────────────────────────────────
 *  - Se um adapter faltar/erro no require ou no init(), logamos e SEGUIMOS — uma API
 *    quebrada não derruba o broker inteiro.
 */

const fs = require('fs');
const path = require('path');
const brokerPackage = require('./package.json');
const express = require('express');

const util = require('./lib/util');
const passport = require('./lib/passport');
const { buildProviderInventory } = require('./lib/provider-inventory');

// Ordem de tentativa de carga dos adapters. Cada arquivo pode ainda não existir
// (criado em paralelo por outro agente) ou falhar no init → boot resiliente.
const ADAPTER_NAMES = ['mentorian', 'evolution', 'evogo', 'wuzapi', 'waha', 'uazapi'];

// REGISTRY keyed por id EXATO do adapter: { [id]: { adapter, ctx } }.
const registry = {};

// Módulos carregados (mesmo se desabilitados no boot) — p/ config em runtime
// (POST /config/:api habilita ex.: UAZAPI hospedada sem rebuild).
const modules = {};

const secret = process.env.HUB_SECRET || '';
const mutationsEnabled = process.env.HUB_MUTATIONS_ENABLED === 'true';
const staticUiEnabled = process.env.HUB_STATIC_UI_ENABLED === 'true';
const mentorianMigrationsEnabled = process.env.MENTORIAN_MIGRATIONS_ENABLED === 'true';
const MENTORIAN_PROVIDER_MAP = Object.freeze({
  baileys: 'mentorian',
  waha: 'waha',
  evolution: 'evolution',
});

// ── Config runtime por API (suporta instalações EXTERNAS à stack) ──────────────
// Campos genéricos -> env vars que cada adapter lê no init(). O overlay parte de
// process.env (padrão da stack) e SÓ sobrescreve o que foi configurado — sem
// campo extra o comportamento é idêntico ao default (sem regressão).
const CONFIG_FIELD_MAP = {
  mentorian:  { apiUrl: 'MENTORIAN_GATEWAY_URL', token: 'MENTORIAN_GATEWAY_SHARED_SECRET' },
  uazapi:    { apiUrl: 'UAZAPI_API_URL', token: 'UAZAPI_ADMIN_TOKEN' },
  waha:      { apiUrl: 'WAHA_API_URL', token: 'WAHA_API_KEY', sessionsDir: 'WAHA_SESSIONS_DIR', engine: 'WAHA_ENGINE' },
  evolution: { apiUrl: 'EVO_API_URL', token: 'EVO_API_KEY', databaseUri: 'EVO_DATABASE_URI', redisUri: 'EVO_REDIS_URI', redisPrefix: 'EVO_REDIS_PREFIX', dbSchema: 'EVO_DB_SCHEMA' },
  evogo:     { apiUrl: 'EVOGO_API_URL', token: 'EVOGO_API_KEY', authDatabaseUri: 'EVOGO_AUTH_DATABASE_URI', usersDatabaseUri: 'EVOGO_USERS_DATABASE_URI' },
  wuzapi:    { apiUrl: 'WUZAPI_API_URL', token: 'WUZAPI_ADMIN_TOKEN', databaseUri: 'WUZAPI_DATABASE_URI', importMode: 'WUZAPI_IMPORT_MODE' },
};

// Overlays persistidos em disco (volume broker_config) — sobrevivem a restart e a
// rebuild da imagem. Contêm tokens/DSNs em claro (mesma classe de segredo do .env).
const CONFIG_DIR = process.env.BROKER_CONFIG_DIR || __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, 'runtime-config.json');
let overlays = {}; // { [api]: { apiUrl, token, webhookUrl, databaseUri, ... } }

function loadOverlays() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    overlays = (data && data.apis) || {};
  } catch (_e) {
    overlays = {}; // sem arquivo/corrompido = sem overlays (padrão da stack)
  }
}
function saveOverlays() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ version: 1, apis: overlays }, null, 2), { mode: 0o600 });
  } catch (e) {
    util.errlog('config: falha ao salvar runtime-config.json (segue em memória)', e && e.message);
  }
}
// Mascara a senha de um DSN/URI (postgres://user:SENHA@host -> user:***@host).
function maskUri(v) {
  if (!v) return '';
  return String(v).replace(/(\/\/[^:@/]+:)[^@]+(@)/, '$1***$2');
}

// Monta o env-overlay a partir dos campos e (re)inicializa a API no registry.
async function applyApiConfig(name, fields) {
  const mod = modules[name];
  if (!mod) return { ok: false, error: 'UNKNOWN_API' };
  const map = CONFIG_FIELD_MAP[name] || {};
  const overlay = Object.assign({}, process.env);
  Object.keys(map).forEach((k) => {
    if (fields[k] != null && String(fields[k]).trim() !== '') overlay[map[k]] = String(fields[k]).trim();
  });
  if (typeof mod.enabled === 'function' && !mod.enabled(overlay)) {
    return { ok: false, error: 'BAD_CONFIG' };
  }
  if (registry[mod.id] && typeof mod.close === 'function') {
    try { await mod.close(registry[mod.id].ctx); } catch (_e) { /* ignore */ }
  }
  const ctx = await mod.init(overlay);
  if (fields.webhookUrl) ctx.defaultWebhook = String(fields.webhookUrl);
  registry[mod.id] = { adapter: mod, ctx };
  return { ok: true };
}

const app = express();
app.use(express.json({ limit: '15mb' }));

// Na instalacao Mentorian a UI upstream fica desligada: ela persiste HUB_SECRET
// no localStorage. O painel privado do MentorOps usa o broker server-to-server.
if (staticUiEnabled) {
  app.use(express.static(path.join(__dirname, 'public')));
}

// ── /health (SEM secret) ───────────────────────────────────────────────────────
// Público: liveness + quais APIs subiram no registry.
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: brokerPackage.version,
    apis: Object.keys(registry),
    mode: mutationsEnabled ? 'mutations-enabled' : 'read-only',
    staticUi: staticUiEnabled,
  });
});

// ── Gate de secret: tudo abaixo exige x-hub-secret ──────────────────────────────
// Montado DEPOIS do static e do /health, ANTES das rotas de dados.
app.use(util.requireSecret(secret));

// Helper: resolve a entry do registry por id EXATO (evogo != evo). 404 UNKNOWN_API
// se a API não está registrada/subiu.
function requireApi(req, res) {
  const api = req.params.api;
  const entry = registry[api];
  if (!entry) {
    res.status(404).json({ error: 'UNKNOWN_API', api });
    return null;
  }
  return entry;
}

// ── GET /sessions — lista UNIFICADA ────────────────────────────────────────────
// Chama list() de cada API. [AUDIT] uma falha NÃO derruba as outras (try/catch por
// API). Anexa api:id e number (item.number || jidToNumber(item.jid)) — number é a
// chave do DEDUP na migração.
app.get('/sessions', async (req, res) => {
  const sessions = [];
  const errors = {};
  const keys = Object.keys(registry);
  for (const key of keys) {
    const { adapter, ctx } = registry[key];
    try {
      const items = (await adapter.list(ctx)) || [];
      for (const it of items) {
        const number = it && (it.number || util.jidToNumber(it.jid));
        sessions.push({ ...it, api: adapter.id, number });
      }
    } catch (e) {
      util.errlog('GET /sessions: list falhou em', key, e && e.message);
      errors[key] = e && e.message ? e.message : 'list failed';
    }
  }
  const body = { sessions };
  if (Object.keys(errors).length) body.errors = errors;
  res.json(body);
});

// ── GET /:api/qr?id=<s> — proxy do QR ──────────────────────────────────────────
app.get('/:api/qr', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  try {
    const out = await entry.adapter.qr(entry.ctx, req.query.id);
    res.json(out);
  } catch (e) {
    util.errlog('GET /:api/qr falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'QR_FAILED', message: e && e.message });
  }
});

// ── POST /:api/create { name } — cria sessão ───────────────────────────────────
app.post('/:api/create', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  const name = req.body && req.body.name;
  if (!name) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'name é obrigatório' });
  }
  try {
    const out = await entry.adapter.createSession(entry.ctx, name);
    res.json(out);
  } catch (e) {
    util.errlog('POST /:api/create falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'CREATE_FAILED', message: e && e.message });
  }
});

// ── POST /:api/send { id, to, text } — envio de TEXTO de teste ─────────────────
// Confirma que a sessão realmente envia (útil p/ validar logo após migrar de API).
app.post('/:api/send', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  const { id, to, text } = req.body || {};
  if (!id || !to || !text) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'id, to e text são obrigatórios' });
  }
  if (typeof entry.adapter.sendText !== 'function') {
    return res.status(501).json({ error: 'NOT_SUPPORTED', message: 'adapter sem sendText' });
  }
  try {
    const out = await entry.adapter.sendText(entry.ctx, id, to, text);
    res.json(out);
  } catch (e) {
    util.errlog('POST /:api/send falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'SEND_FAILED', message: e && e.message });
  }
});

// ── POST /:api/import { id, passport|creds } — grava passaporte + connect ───────
app.post('/:api/import', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  const id = req.body && req.body.id;
  if (!id) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'id é obrigatório' });
  }
  // Desembrulha { passport|creds|export-completo } → dump do Contrato A, valida mínimos.
  const dump = passport.unwrapDump(req.body);
  const missing = passport.passportMissing(dump);
  if (missing.length) {
    return res.status(400).json({ error: 'PASSPORT_INVALID', missing });
  }
  try {
    const out = await entry.adapter.importPassport(entry.ctx, id, dump);
    res.json(out);
  } catch (e) {
    util.errlog('POST /:api/import falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'IMPORT_FAILED', message: e && e.message });
  }
});

// ── GET /:api/export?id=<s> — lê a store → { passport } ─────────────────────────
// UAZAPI (destino-only) lança NotSupportedError → 501 NOT_SUPPORTED.
app.get('/:api/export', async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  try {
    const out = await entry.adapter.exportPassport(entry.ctx, req.query.id);
    res.json(out);
  } catch (e) {
    if (e instanceof util.NotSupportedError || (e && e.code === 'NOT_SUPPORTED')) {
      return res.status(501).json({ error: 'NOT_SUPPORTED' });
    }
    util.errlog('GET /:api/export falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'EXPORT_FAILED', message: e && e.message });
  }
});

// ── POST /migrate — orquestra a migração 1-clique ─────────────────────────
// require em runtime (migrate.js pode evoluir independente; mantém o boot leve).
app.post('/migrate', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const migrate = require('./migrate');
  try {
    const r = await migrate.run(registry, req.body);
    res.json(r);
  } catch (e) {
    // Erros conhecidos carregam .status (400 validação, 409 lock/dedup); resto = 500.
    if (e instanceof migrate.MigrateError) {
      return res.status(e.status || 500).json({ error: e.code, message: e.message });
    }
    util.errlog('POST /migrate falhou', e && e.message, e && e.stack);
    res.status(500).json({ error: 'MIGRATE_FAILED', message: e && e.message });
  }
});

// Escopo estreito usado pelo MentorOps: somente Mentorian Baileys -> WAHA.
// Mantem as demais mutacoes do WAHub bloqueadas no ambiente Mentorian.
app.post('/mentorian/migrate-to-waha', async (req, res) => {
  if (!mentorianMigrationsEnabled) {
    return res.status(503).json({ error: 'MENTORIAN_MIGRATIONS_DISABLED' });
  }
  const workspaceId = String((req.body && req.body.workspaceId) || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(workspaceId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'workspaceId invalido' });
  }
  const migrate = require('./migrate');
  try {
    const result = await migrate.run(registry, {
      from: { api: 'mentorian', id: workspaceId },
      to: { api: 'waha', name: workspaceId },
      tier: 1,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof migrate.MigrateError) {
      return res.status(e.status || 500).json({ error: e.code, message: e.message });
    }
    util.errlog('Mentorian -> WAHA falhou', e && e.name);
    res.status(500).json({ error: 'MIGRATE_FAILED' });
  }
});

// Contrato privado do MentorOps: seleção bidirecional entre os motores
// homologados. Nunca aceita APIs arbitrárias enviadas pelo navegador.
app.post('/mentorian/migrate-provider', async (req, res) => {
  if (!mentorianMigrationsEnabled) {
    return res.status(503).json({ error: 'MENTORIAN_MIGRATIONS_DISABLED' });
  }
  const workspaceId = String((req.body && req.body.workspaceId) || '').trim();
  const from = String((req.body && req.body.from) || '');
  const to = String((req.body && req.body.to) || '');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(workspaceId) || !MENTORIAN_PROVIDER_MAP[from] || !MENTORIAN_PROVIDER_MAP[to] || from === to) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Seleção de provedor inválida' });
  }
  const migrate = require('./migrate');
  try {
    const result = await migrate.run(registry, {
      from: { api: MENTORIAN_PROVIDER_MAP[from], id: workspaceId },
      to: to === 'baileys'
        ? { api: MENTORIAN_PROVIDER_MAP[to], id: workspaceId }
        : { api: MENTORIAN_PROVIDER_MAP[to], name: workspaceId },
      webhook: to === 'waha' || to === 'evolution' ? req.body.webhook : null,
      tier: 2,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof migrate.MigrateError) {
      return res.status(e.status || 500).json({ error: e.code, message: e.message });
    }
    util.errlog('Mentorian provider migration failed', e && e.name);
    res.status(500).json({ error: 'MIGRATE_FAILED' });
  }
});

// Inventário privado e sanitizado dos motores homologados pela Mentorian.
// Não expõe sessões, números, credenciais ou provedores ainda não liberados no produto.
app.post('/mentorian/provider-inventory', async (_req, res) => {
  try {
    const inventory = await buildProviderInventory({ registry, env: process.env });
    res.json(inventory);
  } catch (error) {
    util.errlog('Mentorian provider inventory failed', error && error.name);
    res.status(502).json({ error: 'PROVIDER_INVENTORY_FAILED' });
  }
});

app.post('/mentorian/configure-waha', async (req, res) => {
  req.body = { ...(req.body || {}), provider: 'waha' };
  return configureMentorianProvider(req, res);
});

app.post('/mentorian/configure-provider', configureMentorianProvider);

async function configureMentorianProvider(req, res) {
  const resolved = mentorianProviderRequest(req, res);
  if (!resolved) return;
  const { workspaceId, provider, entry } = resolved;
  if (provider === 'baileys') {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Baileys usa webhook fixo do gateway' });
  }
  try {
    await entry.adapter.setWebhook(entry.ctx, workspaceId, req.body && req.body.webhook);
    const status = await entry.adapter.status(entry.ctx, workspaceId);
    res.json({ ok: status.connected === true, connected: status.connected === true, status: status.connected ? 'WORKING' : 'STOPPED' });
  } catch (e) {
    util.errlog('Mentorian provider webhook configuration failed', provider, e && e.name);
    res.status(502).json({ error: 'PROVIDER_CONFIGURATION_FAILED' });
  }
}

app.post('/mentorian/waha-status', async (req, res) => {
  req.body = { ...(req.body || {}), provider: 'waha' };
  return mentorianProviderStatus(req, res);
});
app.post('/mentorian/provider-status', mentorianProviderStatus);

async function mentorianProviderStatus(req, res) {
  const resolved = mentorianProviderRequest(req, res);
  if (!resolved) return;
  const { workspaceId, entry } = resolved;
  const status = await entry.adapter.status(entry.ctx, workspaceId);
  res.json({
    ok: true,
    connected: status.connected === true,
    status: status.connected ? 'WORKING' : 'STOPPED',
    phone: util.jidToNumber(status.jid),
  });
}

app.post('/mentorian/waha-send', async (req, res) => {
  req.body = { ...(req.body || {}), provider: 'waha' };
  return mentorianProviderSend(req, res);
});
app.post('/mentorian/provider-send', mentorianProviderSend);

async function mentorianProviderSend(req, res) {
  const resolved = mentorianProviderRequest(req, res);
  if (!resolved) return;
  const { workspaceId, provider, entry } = resolved;
  try {
    const result = await entry.adapter.sendText(
      entry.ctx,
      workspaceId,
      req.body && req.body.phone,
      req.body && req.body.text,
    );
    res.json(result);
  } catch (e) {
    util.errlog('Mentorian provider send failed', provider, e && e.name);
    res.status(502).json({ error: 'PROVIDER_SEND_FAILED' });
  }
}

app.post('/mentorian/waha-send-media', async (req, res) => {
  req.body = { ...(req.body || {}), provider: 'waha' };
  return mentorianProviderSendMedia(req, res);
});
app.post('/mentorian/provider-send-media', mentorianProviderSendMedia);

async function mentorianProviderSendMedia(req, res) {
  const resolved = mentorianProviderRequest(req, res);
  if (!resolved) return;
  const { workspaceId, provider, entry } = resolved;
  if (typeof entry.adapter.sendMedia !== 'function') {
    return res.status(501).json({ error: 'NOT_SUPPORTED' });
  }
  try {
    const result = await entry.adapter.sendMedia(
      entry.ctx,
      workspaceId,
      {
        to: req.body && req.body.phone,
        kind: req.body && req.body.kind,
        mediaUrl: req.body && req.body.mediaUrl,
        mimeType: req.body && req.body.mimeType,
        fileName: req.body && req.body.fileName,
        caption: req.body && req.body.caption,
        ptt: req.body && req.body.ptt,
      },
    );
    res.json(result);
  } catch (e) {
    util.errlog('Mentorian provider media send failed', provider, e && e.name);
    res.status(502).json({ error: 'PROVIDER_MEDIA_SEND_FAILED' });
  }
}

app.post('/mentorian/waha-presence', async (req, res) => {
  req.body = { ...(req.body || {}), provider: 'waha' };
  return mentorianProviderPresence(req, res);
});
app.post('/mentorian/provider-presence', mentorianProviderPresence);

async function mentorianProviderPresence(req, res) {
  const resolved = mentorianProviderRequest(req, res);
  if (!resolved) return;
  const { workspaceId, provider, entry } = resolved;
  if (typeof entry.adapter.setPresence !== 'function') {
    return res.status(501).json({ error: 'NOT_SUPPORTED' });
  }
  try {
    const result = await entry.adapter.setPresence(
      entry.ctx,
      workspaceId,
      req.body && req.body.phone,
      req.body && req.body.state,
    );
    res.json(result);
  } catch (e) {
    util.errlog('Mentorian provider presence failed', provider, e && e.name);
    res.status(502).json({ error: 'PROVIDER_PRESENCE_FAILED' });
  }
}

function mentorianProviderRequest(req, res) {
  const provider = String((req.body && req.body.provider) || '').trim();
  const adapterId = MENTORIAN_PROVIDER_MAP[provider];
  const entry = adapterId && registry[adapterId];
  if (!mentorianMigrationsEnabled || !entry) {
    res.status(503).json({ error: 'MENTORIAN_PROVIDER_DISABLED' });
    return null;
  }
  const workspaceId = String((req.body && req.body.workspaceId) || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(workspaceId)) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'workspaceId invalido' });
    return null;
  }
  return { workspaceId, provider, entry };
}

// ── POST /:api/restart?id=<s> — regenera o QR (reinicia a sessão) ──────────────
app.post('/:api/restart', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  const id = req.query.id || (req.body && req.body.id);
  if (!id) return res.status(400).json({ error: 'BAD_REQUEST', message: 'id é obrigatório' });
  if (typeof entry.adapter.restart !== 'function') {
    return res.status(501).json({ error: 'NOT_SUPPORTED' });
  }
  try {
    const out = await entry.adapter.restart(entry.ctx, id);
    res.json(out || { ok: true });
  } catch (e) {
    util.errlog('POST /:api/restart falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'RESTART_FAILED', message: e && e.message });
  }
});

// ── POST /:api/disconnect?id=<s> — desconecta a sessão (mantém as creds) ────────
// Para o socket sem deslogar/desregistrar. (Evolution não expõe isso via HTTP → no-op.)
app.post('/:api/disconnect', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  const id = req.query.id || (req.body && req.body.id);
  if (!id) return res.status(400).json({ error: 'BAD_REQUEST', message: 'id é obrigatório' });
  if (typeof entry.adapter.disconnect !== 'function') {
    return res.status(501).json({ error: 'NOT_SUPPORTED' });
  }
  try {
    await entry.adapter.disconnect(entry.ctx, id);
    res.json({ ok: true });
  } catch (e) {
    util.errlog('POST /:api/disconnect falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'DISCONNECT_FAILED', message: e && e.message });
  }
});

// ── DELETE /:api/session?id=<s> — remove a sessão da API ───────────────────────
app.delete('/:api/session', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const entry = requireApi(req, res);
  if (!entry) return;
  const id = req.query.id || (req.body && req.body.id);
  if (!id) return res.status(400).json({ error: 'BAD_REQUEST', message: 'id é obrigatório' });
  if (typeof entry.adapter.deleteSession !== 'function') {
    return res.status(501).json({ error: 'NOT_SUPPORTED' });
  }
  try {
    const out = await entry.adapter.deleteSession(entry.ctx, id);
    res.json(out || { ok: true });
  } catch (e) {
    util.errlog('DELETE /:api/session falhou', req.params.api, e && e.message);
    res.status(500).json({ error: 'DELETE_FAILED', message: e && e.message });
  }
});

// ── GET /config — config atual das APIs (segredos/DSNs mascarados) ─────────────
// `custom` = overlay runtime aplicado (instalação externa/custom); `fields` traz os
// valores EFETIVOS (overlay salvo > env da stack) com senha de URI mascarada.
app.get('/config', (req, res) => {
  const mask = (v) => (v ? String(v).slice(0, 3) + '***' : '');
  const out = {};
  for (const name of ADAPTER_NAMES) {
    const mod = modules[name];
    const id = mod && mod.id ? mod.id : name;
    const ctx = registry[id] && registry[id].ctx;
    const ov = overlays[name] || null;
    const map = CONFIG_FIELD_MAP[name] || {};
    const fields = {};
    Object.keys(map).forEach((k) => {
      if (k === 'token') return; // token sai só como secretMasked
      const v = (ov && ov[k]) || process.env[map[k]] || '';
      fields[k] = /uri$/i.test(k) ? maskUri(v) : v;
    });
    out[id] = {
      enabled: !!registry[id],
      custom: !!ov,
      apiUrl: (ctx && ctx.apiUrl) || (ov && ov.apiUrl) || '',
      hasSecret: !!(ctx && (ctx.adminToken || ctx.apiKey)),
      secretMasked: ctx ? mask(ctx.adminToken || ctx.apiKey) : '',
      webhookUrl: (ctx && ctx.defaultWebhook) || '',
      fields,
    };
  }
  res.json({ config: out });
});

// ── POST /config/:api — configura a API em runtime (inclui instalação EXTERNA) ─
// Body: { apiUrl, adminToken|apiKey|token, webhookUrl, databaseUri, redisUri,
//         redisPrefix, dbSchema, authDatabaseUri, usersDatabaseUri, importMode,
//         sessionsDir, engine, reset }
// Campo vazio/omitido MANTÉM o valor anterior (tokens/DSNs não precisam ser
// redigitados). `reset:true` descarta o overlay e volta ao padrão da stack (.env).
// Overlays são PERSISTIDOS em CONFIG_FILE (volume) — sobrevivem a restart/rebuild.
app.post('/config/:api', util.requireMutationsEnabled(mutationsEnabled), async (req, res) => {
  const name = req.params.api;
  const mod = modules[name];
  if (!mod) return res.status(404).json({ error: 'UNKNOWN_API', api: name });
  const b = req.body || {};

  if (b.reset === true) {
    delete overlays[name];
    saveOverlays();
    if (registry[mod.id] && typeof mod.close === 'function') {
      try { await mod.close(registry[mod.id].ctx); } catch (_e) { /* ignore */ }
    }
    delete registry[mod.id];
    try {
      if (typeof mod.enabled === 'function' && mod.enabled(process.env)) {
        const ctx = await mod.init(process.env);
        registry[mod.id] = { adapter: mod, ctx };
      }
    } catch (e) {
      util.errlog('config reset: re-init do padrão falhou', name, e && e.message);
    }
    util.log('config runtime removida (padrão da stack):', name, 'enabled=' + !!registry[mod.id]);
    return res.json({ ok: true, api: mod.id, enabled: !!registry[mod.id], custom: false });
  }

  // merge com o overlay salvo: só campos preenchidos sobrescrevem.
  const fields = Object.assign({}, overlays[name] || {});
  const setIf = (k, v) => { if (v != null && String(v).trim() !== '') fields[k] = String(v).trim(); };
  setIf('apiUrl', b.apiUrl);
  setIf('token', b.adminToken || b.apiKey || b.token);
  setIf('databaseUri', b.databaseUri);
  setIf('redisUri', b.redisUri);
  setIf('redisPrefix', b.redisPrefix);
  setIf('dbSchema', b.dbSchema);
  setIf('authDatabaseUri', b.authDatabaseUri);
  setIf('usersDatabaseUri', b.usersDatabaseUri);
  setIf('importMode', b.importMode);
  setIf('sessionsDir', b.sessionsDir);
  setIf('engine', b.engine);
  // webhook explícito: string vazia LIMPA (o form sempre envia o campo).
  if (b.webhookUrl != null) {
    const w = String(b.webhookUrl).trim();
    if (w) fields.webhookUrl = w; else delete fields.webhookUrl;
  }

  try {
    const r = await applyApiConfig(name, fields);
    if (!r.ok) {
      const msg = r.error === 'BAD_CONFIG' ? 'faltam campos p/ habilitar ' + name : String(r.error);
      return res.status(400).json({ error: r.error || 'BAD_CONFIG', message: msg });
    }
    overlays[name] = fields;
    saveOverlays();
    util.log('config runtime aplicada:', mod.id, '(custom/externa; webhook=' + (fields.webhookUrl ? 'sim' : 'não') + ')');
    res.json({ ok: true, api: mod.id, enabled: true, custom: true });
  } catch (e) {
    util.errlog('POST /config/:api falhou', name, e && e.message);
    res.status(500).json({ error: 'CONFIG_FAILED', message: e && e.message });
  }
});

// ── 404 padrão ─────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND' });
});

// ── boot(): carrega adapters (resiliente) e sobe o servidor ─────────────────────
async function boot() {
  if (!secret) {
    // Sem segredo, todas as rotas de dados ficariam abertas (ou 401 eterno).
    // Abortamos com mensagem clara — não subir um broker sem HUB_SECRET.
    util.errlog('HUB_SECRET vazio — abortando boot. Defina HUB_SECRET no ambiente.');
    throw new Error('HUB_SECRET is required');
  }

  for (const name of ADAPTER_NAMES) {
    let adapter;
    try {
      // require em runtime: o arquivo pode ainda não existir (criado em paralelo).
      adapter = require('./adapters/' + name);
    } catch (e) {
      util.errlog('adapter não carregou (pulando):', name, e && e.message);
      continue;
    }
    if (adapter && adapter.id) modules[adapter.id] = adapter; // guarda p/ config runtime
    try {
      if (typeof adapter.enabled !== 'function' || !adapter.enabled(process.env)) {
        util.log('adapter desabilitado (env):', name);
        continue;
      }
      const ctx = await adapter.init(process.env);
      // Anti-colisão: keyed pelo id EXATO exportado pelo adapter, não pelo nome do arquivo.
      registry[adapter.id] = { adapter, ctx };
      util.log('adapter pronto:', adapter.id, '(family=' + adapter.family + ')');
    } catch (e) {
      // Boot resiliente: init de um adapter falhando não derruba o processo.
      util.errlog('adapter falhou no init (pulando):', name, e && e.message);
    }
  }

  // Config runtime PERSISTIDA (instalações externas): reaplica os overlays salvos
  // por cima do padrão da stack. Falha em um overlay não derruba o boot.
  loadOverlays();
  for (const name of Object.keys(overlays)) {
    try {
      const r = await applyApiConfig(name, overlays[name]);
      util.log('config runtime restaurada:', name, r.ok ? 'OK' : ('falhou: ' + r.error));
    } catch (e) {
      util.errlog('config runtime restaurada falhou:', name, e && e.message);
    }
  }

  const port = process.env.PORT || 8090;
  const server = app.listen(port, () => {
    util.log('broker ouvindo em :' + port, '· apis=[' + Object.keys(registry).join(',') + ']');
  });
  return server;
}

// ── Shutdown gracioso (SIGTERM/SIGINT) ─────────────────────────────────────────
// Fecha cada adapter (pools/clients) e sai. Failsafe: força a saída se algum close()
// travar (setTimeout unref p/ não segurar o event loop).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  util.log('shutdown:', signal);
  const failsafe = setTimeout(() => {
    util.errlog('shutdown: failsafe timeout — forçando saída');
    process.exit(0);
  }, 10000);
  failsafe.unref();
  for (const key of Object.keys(registry)) {
    const { adapter, ctx } = registry[key];
    try {
      if (typeof adapter.close === 'function') await adapter.close(ctx);
    } catch (e) {
      util.errlog('shutdown: close falhou em', key, e && e.message);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

boot().catch((e) => {
  util.errlog('boot falhou:', e && e.message);
  process.exit(1);
});

module.exports = { app, registry, boot };
