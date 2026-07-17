'use strict';

/**
 * adapters/uazapi.js — adapter UAZAPI (whatsmeow, SaaS hospedado) do broker.
 *
 * ── SaaS hospedado / destino-only ───────────────────────────────────────────────
 * A UAZAPI e um servico HOSPEDADO: nao ha acesso ao DB nem endpoint de export, entao
 * NAO da p/ ler a store → o passaporte. Portanto e DESTINO-ONLY: importa (recebe uma
 * migracao) mas nunca exporta / nunca e origem de migracao (exportPassport lanca
 * NotSupportedError). Mesma familia do WuzAPI (whatsmeow); o `/instance/import-creds`
 * exige as 3 publicas (ensurePublics cobre) e AUTO-CONECTA (connect_queued) — NAO
 * chamar /instance/connect depois do import.
 *
 * ── Identidade / token ──────────────────────────────────────────────────────────
 * `id === instance id`. Como nao ha DB local, o token de cada instancia e resolvido
 * via `GET /instance/all` (auth admintoken) e cacheado em ctx.tokenCache[id].
 *
 * ── Auth HTTP ──────────────────────────────────────────────────────────────────
 * - header `admintoken: UAZAPI_ADMIN_TOKEN` → /instance/init e /instance/all.
 * - header `token: <instanceToken>` → ops de instancia (connect/qr/status/import/
 *   disconnect/webhook). (Nomes de rota e headers confirmados em producao —
 *   todos usam `token`/`admintoken`.)
 *
 * ── disconnect ─────────────────────────────────────────────────────────────────
 * POST /instance/disconnect — para o socket mantendo o device. NUNCA logout.
 */

const passport = require('../lib/passport');
const util = require('../lib/util');

// Header de admin (init/all).
function adminHeaders(ctx) {
  return { admintoken: ctx.adminToken };
}
// Header de instancia (ops por token).
function tokenHeaders(token) {
  return { token: String(token || '') };
}

// Le id da instancia do item cru de /instance/all (varia: id | instanceId | token).
function readInstanceId(inst) {
  if (!inst || typeof inst !== 'object') return '';
  return String(inst.id || inst.instanceId || inst.instance || '') || '';
}
// Le o token da instancia do item cru.
function readInstanceToken(inst) {
  if (!inst || typeof inst !== 'object') return '';
  return String(inst.token || inst.apiToken || '') || '';
}
// JID/dono do item cru (formato do owner: "5511...@s.whatsapp.net").
function readOwnerJid(inst) {
  if (!inst || typeof inst !== 'object') return '';
  return String(inst.owner || inst.jid || inst.wid || '') || '';
}
// Nome legivel da instancia.
function readInstanceName(inst) {
  if (!inst || typeof inst !== 'object') return '';
  return String(inst.name || inst.profileName || '') || '';
}
// Status cru (string) e flag connected.
function readStatusStr(inst) {
  if (!inst || typeof inst !== 'object') return '';
  return String(inst.status || inst.state || '') || '';
}
function isConnected(inst) {
  if (!inst || typeof inst !== 'object') return false;
  if (inst.connected === true) return true;
  if (inst.loggedIn === true) return true;
  return readStatusStr(inst).toLowerCase() === 'connected';
}

// Busca o array cru de instancias em /instance/all (shape defensivo).
function extractInstances(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.instances)) return data.instances;
  if (data && Array.isArray(data.instance)) return data.instance;
  return [];
}

module.exports = {
  id: 'uazapi',
  family: 'whatsmeow',

  enabled(env) {
    return !!(env && env.UAZAPI_API_URL && env.UAZAPI_ADMIN_TOKEN);
  },

  async init(env) {
    const apiUrl = String((env && env.UAZAPI_API_URL) || '').replace(/\/+$/, '');
    const adminToken = String((env && env.UAZAPI_ADMIN_TOKEN) || '');
    // `created`: sessões criadas via ESTE hub (id -> {name,token}). Garantem que a sessão
    // recém-criada apareça na lista mesmo que o /instance/all (hospedado) ainda não a retorne.
    return { apiUrl, adminToken, tokenCache: {}, created: {} };
  },

  // Resolve (e cacheia) o token da instancia via /instance/all. Sem DB local, essa e
  // a unica forma de obter o token de instancia a partir do id.
  async resolveToken(ctx, id) {
    const key = String(id);
    if (ctx.tokenCache[key]) return ctx.tokenCache[key];
    const r = await util.httpJson('GET', `${ctx.apiUrl}/instance/all`, {
      headers: adminHeaders(ctx),
    });
    if (!r.ok) {
      throw new passport.CredsError(
        'INSTANCE_LOOKUP_FAILED',
        `UAZAPI GET /instance/all status=${r.status} detail=${JSON.stringify(r.data)}`
      );
    }
    for (const inst of extractInstances(r.data)) {
      const iid = readInstanceId(inst);
      const tok = readInstanceToken(inst);
      if (iid && tok) ctx.tokenCache[iid] = tok; // refresca o cache inteiro de passagem
    }
    const token = ctx.tokenCache[key];
    if (!token) {
      throw new passport.CredsError('INSTANCE_NOT_FOUND', `instancia "${key}" nao encontrada em /instance/all`);
    }
    return token;
  },

  // ── list ──────────────────────────────────────────────────────────────────────
  // GET {apiUrl}/instance/all (admintoken) → normaliza + cacheia id→token.
  async list(ctx) {
    const out = [];
    const seen = new Set();
    const r = await util.httpJson('GET', `${ctx.apiUrl}/instance/all`, {
      headers: adminHeaders(ctx),
    });
    if (r.ok) {
      for (const inst of extractInstances(r.data)) {
        const id = readInstanceId(inst);
        const token = readInstanceToken(inst);
        if (id && token) ctx.tokenCache[id] = token;
        const jid = readOwnerJid(inst);
        if (id) seen.add(String(id));
        out.push({
          id,
          name: readInstanceName(inst) || id,
          number: jid ? util.jidToNumber(jid) : '',
          jid: jid || null,
          status: readStatusStr(inst) || 'unknown',
          connected: isConnected(inst),
        });
      }
    } else {
      util.errlog(`[uazapi] GET /instance/all status=${r.status}`);
    }
    // Sessões criadas por este hub que o /instance/all ainda não retornou (hospedado pode demorar).
    for (const id of Object.keys(ctx.created || {})) {
      if (seen.has(String(id))) continue;
      const c = ctx.created[id];
      if (c && c.token) ctx.tokenCache[id] = c.token;
      out.push({
        id,
        name: (c && c.name) || id,
        number: '',
        jid: null,
        status: 'CREATED',
        connected: false,
      });
    }
    return out;
  },

  // ── qr ────────────────────────────────────────────────────────────────────────
  // resolveToken → POST /instance/connect (token) → GET /instance/qr ou status.
  async qr(ctx, id) {
    const s = String(id);
    const token = await this.resolveToken(ctx, s);

    let qr = null;
    let code = null;
    let connected = false;

    // 1) connect: a UAZAPI ja devolve qrcode/paircode/owner no corpo do connect.
    try {
      const c = await util.httpJson('POST', `${ctx.apiUrl}/instance/connect`, {
        headers: tokenHeaders(token),
        body: {},
      });
      const inst = (c && c.data && c.data.instance) || {};
      if (inst.qrcode) qr = String(inst.qrcode);
      if (inst.paircode) code = String(inst.paircode);
      if (isConnected(c && c.data) || isConnected(inst)) connected = true;
    } catch (e) {
      util.errlog(`[uazapi] connect id=${s} falhou: ${(e && e.message) || e}`);
    }

    // 2) fallback/refino: /instance/qr direto se o connect nao trouxe o QR.
    if (!qr && !connected) {
      try {
        const q = await util.httpJson('GET', `${ctx.apiUrl}/instance/qr`, {
          headers: tokenHeaders(token),
        });
        const d = (q && q.data) || {};
        const inst = d.instance || d;
        if (inst.qrcode) qr = String(inst.qrcode);
        else if (typeof d.qrcode === 'string') qr = d.qrcode;
        if (inst.paircode && !code) code = String(inst.paircode);
      } catch (e) {
        util.errlog(`[uazapi] qr id=${s} falhou: ${(e && e.message) || e}`);
      }
    }

    // 3) estado atual (autoritativo p/ connected).
    if (!connected) {
      const st = await this.status(ctx, s);
      connected = st.connected;
    }

    return {
      status: connected ? 'connected' : 'qrcode',
      qr,
      code,
      connected,
    };
  },

  // ── createSession ───────────────────────────────────────────────────────────
  // POST {apiUrl}/instance/init { name } (admintoken) → { instance:{ id, token } }.
  async createSession(ctx, name) {
    const nm = String(name || '').trim();
    if (!nm) throw new passport.CredsError('NAME_REQUIRED', 'nome da instancia obrigatorio');
    const initBody = { name: nm };
    if (ctx.defaultWebhook) initBody.webhook = ctx.defaultWebhook; // webhook no init (best-effort)
    const r = await util.httpJson('POST', `${ctx.apiUrl}/instance/init`, {
      headers: adminHeaders(ctx),
      body: initBody,
    });
    if (!r.ok) {
      throw new passport.CredsError(
        'CREATE_FAILED',
        `UAZAPI POST /instance/init status=${r.status} detail=${JSON.stringify(r.data)}`
      );
    }
    // Resposta: response.data.instance = { id, token, owner, status }.
    const inst = (r.data && r.data.instance) || r.data || {};
    const id = readInstanceId(inst);
    const token = readInstanceToken(inst);
    if (!id || !token) {
      throw new passport.CredsError(
        'CREATE_FAILED',
        `UAZAPI /instance/init sem id/token: ${JSON.stringify(r.data)}`
      );
    }
    ctx.tokenCache[id] = token; // ja cacheia p/ ops seguintes sem re-listar
    if (!ctx.created) ctx.created = {};
    ctx.created[id] = { name: nm, token }; // garante que apareça na lista já
    // aplica o webhook default (setado via POST /config/uazapi), se houver.
    if (ctx.defaultWebhook) {
      try { await this.setWebhook(ctx, id, ctx.defaultWebhook); } catch (_e) { /* best-effort */ }
    }
    return { id, name: nm, token };
  },

  // ── importPassport ──────────────────────────────────────────────────────────────
  // ensurePublics → resolveToken → POST /instance/import-creds (token) body=passaporte
  // CRU (Contrato A). A UAZAPI auto-conecta (connect_queued) — NAO chamar connect.
  async importPassport(ctx, id, passportArg) {
    const s = String(id);
    const p = passport.ensurePublics(passportArg);
    const missing = passport.passportMissing(p);
    if (missing.length) {
      throw new passport.CredsError('CREDS_INVALID', `faltando: ${missing.join(', ')}`);
    }
    const token = await this.resolveToken(ctx, s);

    // Body = passaporte CRU (contrato do parceiro, mesma familia WuzAPI). A UAZAPI
    // decodifica base64, monta o device whatsmeow e enfileira a conexao sozinha.
    const r = await util.httpJson('POST', `${ctx.apiUrl}/instance/import-creds`, {
      headers: tokenHeaders(token),
      body: p,
    });
    if (!r.ok || !(r.data && r.data.success)) {
      throw new passport.CredsError(
        'IMPORT_FAILED',
        `UAZAPI /instance/import-creds status=${r.status} detail=${JSON.stringify(r.data)}`
      );
    }
    util.log(
      `[uazapi] import id=${s}: import-creds ok (connect_queued=${r.data && r.data.connect_queued}). ` +
        `Auto-conecta — NAO chamando /instance/connect.`
    );
    const jid = p.me && p.me.id ? p.me.id : null;
    return { ok: true, jid };
  },

  // ── exportPassport ──────────────────────────────────────────────────────────────
  // Destino-only: SaaS hospedado, sem DB/endpoint p/ ler a store.
  async exportPassport(_ctx, _id) {
    throw new util.NotSupportedError('UAZAPI é destino-only (SaaS hospedado, sem DB p/ exportar)');
  },

  // ── setWebhook ────────────────────────────────────────────────────────────────
  // POST {apiUrl}/instance/updateWebhook (token) { url }. Best-effort.
  async setWebhook(ctx, id, url) {
    const s = String(id);
    if (!url) return;
    let token;
    try {
      token = await this.resolveToken(ctx, s);
    } catch (e) {
      util.errlog(`[uazapi] setWebhook id=${s}: resolveToken falhou: ${(e && e.message) || e}`);
      return;
    }
    try {
      const r = await util.httpJson('POST', `${ctx.apiUrl}/instance/updateWebhook`, {
        headers: tokenHeaders(token),
        body: { url, enabled: true },
      });
      if (!r.ok) {
        util.errlog(`[uazapi] setWebhook id=${s} status=${r.status} detail=${JSON.stringify(r.data)}`);
      }
    } catch (e) {
      util.errlog(`[uazapi] setWebhook id=${s} falhou: ${(e && e.message) || e}`);
    }
  },

  // ── disconnect ────────────────────────────────────────────────────────────────
  // POST {apiUrl}/instance/disconnect (token) — para o socket, mantem device. NUNCA logout.
  async disconnect(ctx, id) {
    const s = String(id);
    let token;
    try {
      token = await this.resolveToken(ctx, s);
    } catch (e) {
      util.errlog(`[uazapi] disconnect id=${s}: resolveToken falhou: ${(e && e.message) || e}`);
      return;
    }
    try {
      const r = await util.httpJson('POST', `${ctx.apiUrl}/instance/disconnect`, {
        headers: tokenHeaders(token),
      });
      if (!r.ok) {
        util.errlog(`[uazapi] disconnect id=${s} status=${r.status} detail=${JSON.stringify(r.data)}`);
      }
    } catch (e) {
      util.errlog(`[uazapi] disconnect id=${s} falhou: ${(e && e.message) || e}`);
    }
  },

  // ── status ────────────────────────────────────────────────────────────────────
  // GET {apiUrl}/instance/status (token) → { connected, jid }.
  // Shape: { status: { connected }, instance: { owner, ... } }.
  async status(ctx, id) {
    const s = String(id);
    let token;
    try {
      token = await this.resolveToken(ctx, s);
    } catch (e) {
      util.errlog(`[uazapi] status id=${s}: resolveToken falhou: ${(e && e.message) || e}`);
      return { connected: false, jid: null };
    }
    try {
      const r = await util.httpJson('GET', `${ctx.apiUrl}/instance/status`, {
        headers: tokenHeaders(token),
      });
      const d = (r && r.data) || {};
      // connected pode vir em d.status.connected ou no topo.
      const connected = isConnected(d.status) || isConnected(d) || isConnected(d.instance);
      const jid = readOwnerJid(d.instance) || readOwnerJid(d) || null;
      return { connected, jid };
    } catch (e) {
      util.errlog(`[uazapi] status id=${s} falhou: ${(e && e.message) || e}`);
      return { connected: false, jid: null };
    }
  },

  // ── sendText (teste) ────────────────────────────────────────────────────────
  // Envio de texto p/ validar a sessão. UAZAPI: POST /send/text { number, text }.
  async sendText(ctx, id, to, text) {
    const token = await this.resolveToken(ctx, id);
    const number = String(to || '').replace(/\D/g, '');
    if (!number) throw new Error('uazapi sendText: número inválido');
    const r = await util.httpJson('POST', `${ctx.apiUrl}/send/text`, {
      headers: tokenHeaders(token),
      body: { number, text },
    });
    if (!r.ok) throw new Error(`uazapi sendText: HTTP ${r.status}`);
    const d = r.data || {};
    return { ok: true, messageId: d.messageid || d.id || (d.message && d.message.id) || undefined };
  },

  // ── restart (regenerar QR) ──────────────────────────────────────────────────
  async restart(ctx, id) {
    const token = await this.resolveToken(ctx, id);
    await util.httpJson('POST', `${ctx.apiUrl}/instance/disconnect`, { headers: tokenHeaders(token) }).catch(() => {});
    const r = await util.httpJson('POST', `${ctx.apiUrl}/instance/connect`, { headers: tokenHeaders(token) });
    return { ok: r.ok };
  },

  // ── deleteSession ───────────────────────────────────────────────────────────
  // Remove a instância do UAZAPI (hospedado). [AUDIT] endpoint de delete a confirmar ao vivo.
  async deleteSession(ctx, id) {
    const token = await this.resolveToken(ctx, id).catch(() => null);
    if (token) await util.httpJson('POST', `${ctx.apiUrl}/instance/disconnect`, { headers: tokenHeaders(token) }).catch(() => {});
    let r = await util.httpJson('DELETE', `${ctx.apiUrl}/instance`, { headers: token ? tokenHeaders(token) : adminHeaders(ctx) });
    if (!r.ok) {
      r = await util.httpJson('POST', `${ctx.apiUrl}/instance/delete`, { headers: token ? tokenHeaders(token) : adminHeaders(ctx), body: { id } });
    }
    if (ctx.tokenCache) delete ctx.tokenCache[id];
    if (!r.ok && r.status !== 404) throw new Error(`uazapi delete: HTTP ${r.status}`);
    return { ok: true };
  },

  // ── close ─────────────────────────────────────────────────────────────────────
  async close(_ctx) {
    // no-op (sem pools/clients persistentes; so cache em memoria).
  },
};
