'use strict';

const crypto = require('crypto');
const passport = require('../lib/passport');
const util = require('../lib/util');

function signedHeaders(ctx, method, pathname, workspaceId, body) {
  const timestamp = String(Date.now());
  const requestId = crypto.randomUUID();
  const rawBody = body == null ? '' : JSON.stringify(body);
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const canonical = [method.toUpperCase(), pathname, timestamp, workspaceId, requestId, bodyHash].join('\n');
  const signature = `v2=${crypto.createHmac('sha256', ctx.sharedSecret).update(canonical).digest('hex')}`;
  return {
    rawBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Mentorian-Signature': signature,
      'X-Mentorian-Timestamp': timestamp,
      'X-Mentorian-Workspace-Id': workspaceId,
      'X-Mentorian-Request-Id': requestId,
    },
  };
}

async function call(ctx, workspaceId, action, body = {}) {
  const pathname = `/v1/sessions/${encodeURIComponent(workspaceId)}/${action}`;
  const signed = signedHeaders(ctx, 'POST', pathname, workspaceId, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${ctx.apiUrl}${pathname}`, {
      method: 'POST',
      headers: signed.headers,
      body: signed.rawBody,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((data && data.message) || `Mentorian gateway HTTP ${response.status}`);
      error.status = response.status;
      error.code = data && data.error;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  id: 'mentorian',
  family: 'baileys',

  enabled(env) {
    return !!(
      env &&
      env.MENTORIAN_GATEWAY_URL &&
      (env.MENTORIAN_GATEWAY_SHARED_SECRET || env.WHATSAPP_GATEWAY_SHARED_SECRET)
    );
  },

  async init(env) {
    return {
      apiUrl: String(env.MENTORIAN_GATEWAY_URL).replace(/\/+$/, ''),
      sharedSecret: String(
        env.MENTORIAN_GATEWAY_SHARED_SECRET || env.WHATSAPP_GATEWAY_SHARED_SECRET,
      ),
    };
  },

  async list() {
    return [];
  },

  async readiness(ctx) {
    const response = await fetch(`${ctx.apiUrl}/ready`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) return { ok: false };
    return data;
  },

  async status(ctx, id) {
    let result;
    try {
      result = await call(ctx, String(id), 'migration/export');
    } catch (error) {
      if (error && error.code === 'migration_source_not_connected') {
        return { connected: false, jid: null };
      }
      throw error;
    }
    const creds = JSON.parse(JSON.stringify(result.creds), passport.bufferJsonReviver);
    return {
      connected: true,
      jid: creds && creds.me ? creds.me.id : null,
    };
  },

  async exportPassport(ctx, id) {
    const result = await call(ctx, String(id), 'migration/export');
    const creds = JSON.parse(JSON.stringify(result.creds), passport.bufferJsonReviver);
    return { passport: passport.baileysCredsToPassport(creds) };
  },

  async createSession(_ctx, name) {
    return { id: String(name) };
  },

  async importPassport(ctx, id, dump) {
    const creds = passport.buildBaileysCredsFromWebDump(dump);
    const serialized = JSON.parse(JSON.stringify(creds, passport.bufferJsonReplacer));
    const result = await call(ctx, String(id), 'migration/import', { creds: serialized });
    return { id: String(id), jid: result && result.jid };
  },

  async setWebhook() {
    // O gateway Mentorian possui webhook assinado fixo por configuração.
    return { ok: true };
  },

  async releaseForMigration(ctx, id) {
    await call(ctx, String(id), 'migration/release');
  },

  async commitMigration(ctx, id) {
    await call(ctx, String(id), 'migration/commit');
  },

  async rollbackMigration(ctx, id) {
    await call(ctx, String(id), 'migration/rollback');
  },

  async disconnect(ctx, id) {
    await call(ctx, String(id), 'migration/release');
  },

  async close() {},
};
