'use strict';

/**
 * adapters/waha.js — adapter WAHA (WhatsApp HTTP API) do broker.
 *
 * ── Engine / escopo v1 ──────────────────────────────────────────────────────────
 * A v1 mira EXCLUSIVAMENTE o engine NOWEB (Baileys) — mesma familia do Contrato A
 * baileys, injecao por arquivo `creds.json`. Fixar tag WAHA >= 2026.6.1 (nela o
 * produto e 100% gratis: Postgres/Mongo/GOWS/sessoes ilimitadas, sem license nem
 * phone-home; tags antigas reimpoem 1-sessao/file-only).
 *
 * WEBJS/WPP (perfil de browser Puppeteer) e GOWS (whatsmeow) estao FORA do escopo
 * deste arquivo: WEBJS so exporta (nao reconstruivel de forma estavel), GOWS exige
 * writer whatsmeow per-sessao cujo schema/DB precisa ser confirmado.
 * Se o env indicar outro engine, importPassport lanca NotSupportedError claro.
 *
 * ── Identidade ─────────────────────────────────────────────────────────────────
 * O WAHA identifica a sessao pelo NOME. Aqui `id === name` em TODOS os metodos.
 *
 * ── Store (NOWEB / Baileys) ─────────────────────────────────────────────────────
 * A auth NOWEB vive em `{sessionsDir}/noweb/{s}/creds.json` (JSON no formato
 * BufferJSON do Baileys — SEM o duplo-encode do Evolution). `store.sqlite3` guarda
 * so chats/contatos (separado, nao tocado aqui).
 *
 * ── Auth HTTP ──────────────────────────────────────────────────────────────────
 * Header `X-Api-Key: WAHA_API_KEY` em toda chamada da API.
 *
 * ── disconnect ─────────────────────────────────────────────────────────────────
 * POST /api/sessions/{s}/stop — para o socket SEM deslogar (mantem creds). NUNCA
 * chamar /logout (desregistraria o device / exigiria re-pareamento).
 */

const fs = require('fs');
const path = require('path');
const passport = require('../lib/passport');
const util = require('../lib/util');

const NOWEB_ENGINE = 'NOWEB';
const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';

// Header de auth do WAHA (via util.httpJson headers).
function authHeaders(ctx) {
  return { 'X-Api-Key': ctx.apiKey };
}

// Caminho do creds.json da sessao NOWEB.
function credsPath(ctx, session) {
  return path.join(ctx.sessionsDir, 'noweb', String(session), 'creds.json');
}

// Normaliza o status cru do WAHA (WORKING/STARTING/SCAN_QR_CODE/STOPPED/FAILED...).
function readStatus(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.status || obj.state || '').toUpperCase();
}

// JID do dono (me.id). WAHA expoe `me: { id, pushName }` na sessao.
function readMeId(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const me = obj.me || {};
  return String(me.id || me.jid || '') || '';
}

// Guard de escopo: so NOWEB e suportado nesta v1. Le o engine do env (default NOWEB).
function assertNoweb(ctx, op) {
  const engine = String((ctx && ctx.engine) || NOWEB_ENGINE).toUpperCase();
  if (engine !== NOWEB_ENGINE) {
    throw new util.NotSupportedError(
      `WAHA ${op}: engine "${engine}" fora do escopo da v1 (so NOWEB/Baileys). ` +
        `GOWS (whatsmeow) e WEBJS/WPP (browser) nao sao suportados por este adapter.`
    );
  }
}

// Envelopa base64 cru de QR em data-URI PNG (WAHA as vezes devolve so os bytes/base64).
function ensurePngDataUri(b64) {
  if (!b64 || typeof b64 !== 'string') return b64 || null;
  const s = b64.trim();
  if (!s) return null;
  if (s.startsWith('data:')) return s;
  return PNG_DATA_URI_PREFIX + s;
}

// Baixa o QR do WAHA como BINÁRIO e devolve um data-URI base64 válido.
// (WAHA ?format=image devolve os bytes crus do PNG; util.httpJson faria res.text()
// e corromperia o binário → QR quebrado. Aqui usamos arrayBuffer + base64.)
async function fetchQrDataUri(ctx, s) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${ctx.apiUrl}/api/${encodeURIComponent(s)}/auth/qr?format=image`, {
      headers: { ...authHeaders(ctx), Accept: 'image/png' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      util.errlog(`[waha] qr session=${s} status=${res.status}`);
      return null;
    }
    const ct = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (ct.includes('application/json')) {
      const j = await res.json().catch(() => null);
      if (j && j.data) return String(j.data).startsWith('data:') ? String(j.data) : `data:${j.mimetype || 'image/png'};base64,${j.data}`;
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return `data:${ct || 'image/png'};base64,${buf.toString('base64')}`;
  } catch (e) {
    util.errlog(`[waha] qr session=${s} falhou: ${(e && e.message) || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  id: 'waha',
  family: 'baileys', // engine NOWEB (Baileys) e o alvo da v1

  enabled(env) {
    return !!(env && env.WAHA_API_URL && env.WAHA_API_KEY);
  },

  async init(env) {
    const apiUrl = String((env && env.WAHA_API_URL) || '').replace(/\/+$/, '');
    const apiKey = String((env && env.WAHA_API_KEY) || '');
    // Raiz das sessoes NOWEB (WAHA default: /app/.sessions). O broker precisa desse
    // volume compartilhado p/ escrever/ler creds.json.
    const sessionsDir = String((env && env.WAHA_SESSIONS_DIR) || '/app/.sessions');
    const engine = String((env && env.WAHA_ENGINE) || NOWEB_ENGINE).toUpperCase();
    return { apiUrl, apiKey, sessionsDir, engine };
  },

  async readiness(ctx) {
    const r = await util.httpJson('GET', `${ctx.apiUrl}/api/sessions?all=true`, {
      headers: authHeaders(ctx),
    });
    return { ok: r.ok === true, engine: ctx.engine };
  },

  // ── list ──────────────────────────────────────────────────────────────────────
  // GET {apiUrl}/api/sessions → [{ name, status, me:{ id } }].
  async list(ctx) {
    // ?all=true inclui sessões paradas/recém-criadas (senão só as ativas aparecem).
    const r = await util.httpJson('GET', `${ctx.apiUrl}/api/sessions?all=true`, {
      headers: authHeaders(ctx),
    });
    if (!r.ok) {
      util.errlog(`[waha] GET /api/sessions status=${r.status}`);
      return [];
    }
    let arr = r.data;
    if (arr && !Array.isArray(arr) && Array.isArray(arr.sessions)) arr = arr.sessions;
    if (!Array.isArray(arr)) return [];
    return arr.map((raw) => {
      const s = raw && typeof raw === 'object' ? raw : {};
      const name = String(s.name || '');
      const status = readStatus(s);
      const jid = readMeId(s) || null;
      return {
        id: name,
        name,
        number: jid ? util.jidToNumber(jid) : '',
        jid,
        status: status || 'UNKNOWN',
        connected: status === 'WORKING',
      };
    });
  },

  // ── qr ────────────────────────────────────────────────────────────────────────
  // POST /api/sessions/{s}/start → GET /api/{s}/auth/qr?format=image → poll status.
  async qr(ctx, id) {
    const s = String(id);

    // 0) se a sessao esta FAILED, para antes de re-iniciar (senao o start nao gera QR novo).
    try {
      const cur = await util.httpJson('GET', `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}`, { headers: authHeaders(ctx) });
      if (readStatus(cur && cur.data) === 'FAILED') {
        await util.httpJson('POST', `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/stop`, { headers: authHeaders(ctx) }).catch(() => {});
      }
    } catch (_e) {
      /* ignore */
    }

    // 1) garante a sessao iniciada (idempotente; ja-iniciada nao e erro fatal).
    try {
      const started = await util.httpJson(
        'POST',
        `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/start`,
        { headers: authHeaders(ctx) }
      );
      if (!started.ok) {
        util.errlog(`[waha] start session=${s} status=${started.status} detail=${JSON.stringify(started.data)}`);
      }
    } catch (e) {
      util.errlog(`[waha] start session=${s} falhou: ${(e && e.message) || e}`);
    }

    // 2) busca o QR como binário → base64 (ver fetchQrDataUri). WAHA não expõe
    //    "pairing code" textual aqui (é scan de imagem) → code fica null.
    const code = null;
    const qr = await fetchQrDataUri(ctx, s);

    // 3) estado atual da sessao.
    const st = await this.status(ctx, s);
    return {
      status: st.connected ? 'WORKING' : 'SCAN_QR_CODE',
      qr,
      code,
      connected: st.connected,
    };
  },

  // ── createSession ───────────────────────────────────────────────────────────
  // POST {apiUrl}/api/sessions { name, start:false } (nao inicia; QR vem no /qr).
  async createSession(ctx, name) {
    const nm = String(name || '').trim();
    if (!nm) throw new passport.CredsError('NAME_REQUIRED', 'nome da sessao obrigatorio');
    const r = await util.httpJson('POST', `${ctx.apiUrl}/api/sessions`, {
      headers: authHeaders(ctx),
      body: { name: nm, start: false },
    });
    if (!r.ok) {
      const detail = JSON.stringify(r.data || {});
      // Uma tentativa anterior pode ter criado a sessao e falhado antes do
      // import. Reutilizar apenas uma sessao comprovadamente parada torna o
      // botao idempotente sem apagar, deslogar ou gerar um novo QR Code.
      if (r.status === 422 && /already exists/i.test(detail)) {
        const existing = await util.httpJson(
          'GET',
          `${ctx.apiUrl}/api/sessions/${encodeURIComponent(nm)}`,
          { headers: authHeaders(ctx) },
        );
        if (existing.ok && readStatus(existing.data) === 'STOPPED') {
          return { id: nm, name: nm, reused: true };
        }
      }
      throw new passport.CredsError(
        'CREATE_FAILED',
        `WAHA POST /api/sessions status=${r.status} detail=${detail}`
      );
    }
    const created = (r.data && (r.data.name || (r.data.session && r.data.session.name))) || nm;
    return { id: created, name: created };
  },

  // ── importPassport (engine NOWEB) ───────────────────────────────────────────────
  // ensurePublics → buildBaileysCredsFromWebDump → BufferJSON (1x, SEM duplo-encode)
  // → stop + poll STOPPED → escrever creds.json → start.
  async importPassport(ctx, id, passportArg) {
    const s = String(id);
    assertNoweb(ctx, 'importPassport');

    const p = passport.ensurePublics(passportArg);
    const missing = passport.passportMissing(p);
    if (missing.length) {
      throw new passport.CredsError('CREDS_INVALID', `faltando: ${missing.join(', ')}`);
    }

    const creds = passport.buildBaileysCredsFromWebDump(p);
    // BufferJSON 1x (Buffer -> { type:'Buffer', data:<base64> }). SEM duplo-encode!
    // [AUDIT] confirmar byte-format do creds.json na tag WAHA fixada (BufferJSON presumido) no teste F6.
    const credsJson = JSON.stringify(creds, passport.bufferJsonReplacer);

    // 1) parar a sessao (o cliente vivo nao rele o arquivo; precisa reiniciar).
    try {
      const stopRes = await util.httpJson(
        'POST',
        `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/stop`,
        { headers: authHeaders(ctx) }
      );
      if (!stopRes.ok) {
        util.errlog(`[waha] stop session=${s} status=${stopRes.status} detail=${JSON.stringify(stopRes.data)}`);
      }
    } catch (e) {
      util.errlog(`[waha] stop session=${s} falhou: ${(e && e.message) || e}`);
    }

    // 2) poll ate STOPPED (o creds.json so pode ser reescrito com o socket parado).
    const settled = await util.pollUntil(
      () =>
        util.httpJson('GET', `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}`, {
          headers: authHeaders(ctx),
        }),
      (r) => r && r.ok && readStatus(r.data) === 'STOPPED',
      { timeoutMs: 30000, intervalMs: 1500 }
    );
    if (!settled || !settled.ok || readStatus(settled.data) !== 'STOPPED') {
      util.errlog(
        `[waha] import session=${s}: sessao nao chegou a STOPPED (status=${readStatus(
          settled && settled.data
        )}); gravando creds.json mesmo assim (start posterior recarrega).`
      );
    }

    // 3) escrever o creds.json (cria a pasta recursivamente).
    const file = credsPath(ctx, s);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, credsJson);
      util.log(
        `[waha] import session=${s}: creds.json gravado (${credsJson.length}B) em ${file}`
      );
    } catch (e) {
      throw new passport.CredsError(
        'CREDS_WRITE_FAILED',
        `WAHA nao conseguiu escrever ${file}: ${(e && e.message) || e}`
      );
    }

    // 4) subir a sessao (le o creds.json novo → login sem QR).
    try {
      const startRes = await util.httpJson(
        'POST',
        `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/start`,
        { headers: authHeaders(ctx) }
      );
      if (!startRes.ok) {
        util.errlog(`[waha] start apos import session=${s} status=${startRes.status} detail=${JSON.stringify(startRes.data)}`);
      }
    } catch (e) {
      util.errlog(`[waha] start apos import session=${s} falhou: ${(e && e.message) || e}`);
    }

    const jid = p.me && p.me.id ? p.me.id : null;
    return { ok: true, jid };
  },

  // ── exportPassport (NOWEB) ──────────────────────────────────────────────────────
  // Ler creds.json → reviver BufferJSON → Contrato A.
  async exportPassport(ctx, id) {
    const s = String(id);
    assertNoweb(ctx, 'exportPassport');
    const file = credsPath(ctx, s);
    if (!fs.existsSync(file)) {
      throw new passport.CredsError('SESSION_NOT_FOUND', `creds.json de "${s}" nao encontrado em ${file}`);
    }
    let creds;
    try {
      const txt = fs.readFileSync(file, 'utf8');
      creds = JSON.parse(txt, passport.bufferJsonReviver);
    } catch (e) {
      throw new passport.CredsError(
        'CREDS_INVALID',
        `WAHA nao conseguiu ler/parsear ${file}: ${(e && e.message) || e}`
      );
    }
    return { passport: passport.baileysCredsToPassport(creds) };
  },

  // ── setWebhook ────────────────────────────────────────────────────────────────
  // PUT {apiUrl}/api/sessions/{s} { config:{ webhooks:[{ url, events }] } }. Best-effort.
  async setWebhook(ctx, id, webhook) {
    const s = String(id);
    const config = typeof webhook === 'string' ? { url: webhook } : (webhook || {});
    const url = String(config.url || '').trim();
    if (!url) return;
    const hook = {
      url,
      events: ['message', 'message.ack', 'session.status'],
      retries: { policy: 'exponential', delaySeconds: 2, attempts: 8 },
    };
    if (typeof config.hmacKey === 'string' && config.hmacKey.length >= 32) {
      hook.hmac = { key: config.hmacKey };
    }
    const r = await util.httpJson(
      'PUT',
      `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}`,
      {
        headers: authHeaders(ctx),
        body: {
          config: {
            webhooks: [hook],
            noweb: { markOnline: false },
          },
        },
      }
    );
    if (!r.ok) {
      throw new Error(`WAHA setWebhook HTTP ${r.status}`);
    }
    return { ok: true };
  },

  // ── disconnect ────────────────────────────────────────────────────────────────
  // POST {apiUrl}/api/sessions/{s}/stop — para o socket, mantem creds. NUNCA /logout.
  async disconnect(ctx, id) {
    const s = String(id);
    try {
      const r = await util.httpJson(
        'POST',
        `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/stop`,
        { headers: authHeaders(ctx) }
      );
      if (!r.ok) {
        util.errlog(`[waha] disconnect (stop) session=${s} status=${r.status} detail=${JSON.stringify(r.data)}`);
      }
    } catch (e) {
      util.errlog(`[waha] disconnect (stop) session=${s} falhou: ${(e && e.message) || e}`);
    }
  },

  // ── status ────────────────────────────────────────────────────────────────────
  // GET {apiUrl}/api/sessions/{s} → { connected, jid }.
  async status(ctx, id) {
    const s = String(id);
    try {
      const r = await util.httpJson(
        'GET',
        `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}`,
        { headers: authHeaders(ctx) }
      );
      const status = readStatus(r && r.data);
      const jid = readMeId(r && r.data) || null;
      return { connected: status === 'WORKING', jid };
    } catch (e) {
      util.errlog(`[waha] status session=${s} falhou: ${(e && e.message) || e}`);
      return { connected: false, jid: null };
    }
  },

  // ── sendText (teste) ────────────────────────────────────────────────────────
  // Envio de texto p/ validar a sessão. WAHA: POST /api/sendText { session, chatId, text }.
  async sendText(ctx, id, to, text) {
    const num = String(to || '').replace(/\D/g, '');
    if (!num) throw new Error('waha sendText: número inválido');
    const r = await util.httpJson('POST', `${ctx.apiUrl}/api/sendText`, {
      headers: authHeaders(ctx),
      body: { session: String(id), chatId: `${num}@c.us`, text },
    });
    if (!r.ok) throw new Error(`waha sendText: HTTP ${r.status}`);
    const d = r.data || {};
    const mid = (d.id && (d.id._serialized || d.id.id || d.id)) || d.messageId;
    return { ok: true, messageId: typeof mid === 'string' ? mid : undefined };
  },

  async sendMedia(ctx, id, input) {
    const num = String(input && input.to || '').replace(/\D/g, '');
    const mediaUrl = String(input && input.mediaUrl || '').trim();
    const kind = String(input && input.kind || 'document');
    if (!num || !mediaUrl.startsWith('https://')) {
      throw new Error('waha sendMedia: número ou URL inválida');
    }
    const endpoint = {
      image: 'sendImage',
      audio: input && input.ptt === true ? 'sendVoice' : 'sendFile',
      video: 'sendVideo',
      document: 'sendFile',
    }[kind] || 'sendFile';
    const body = {
      session: String(id),
      chatId: `${num}@c.us`,
      file: {
        url: mediaUrl,
        mimetype: String(input && input.mimeType || 'application/octet-stream'),
        filename: String(input && input.fileName || `arquivo-${Date.now()}`),
      },
      caption: String(input && input.caption || ''),
      ...(endpoint === 'sendVoice' || endpoint === 'sendVideo' ? { convert: true } : {}),
    };
    const r = await util.httpJson('POST', `${ctx.apiUrl}/api/${endpoint}`, {
      headers: authHeaders(ctx),
      body,
    });
    if (!r.ok) throw new Error(`waha sendMedia: HTTP ${r.status}`);
    const d = r.data || {};
    const mid = (d.id && (d.id._serialized || d.id.id || d.id)) || d.messageId;
    return { ok: true, messageId: typeof mid === 'string' ? mid : undefined };
  },

  async setPresence(ctx, id, to, state) {
    const num = String(to || '').replace(/\D/g, '');
    if (!num) throw new Error('waha presence: número inválido');
    const r = await util.httpJson(
      'POST',
      `${ctx.apiUrl}/api/${encodeURIComponent(String(id))}/presence`,
      {
        headers: authHeaders(ctx),
        body: {
          chatId: `${num}@c.us`,
          presence: state === 'composing' ? 'typing' : 'paused',
        },
      }
    );
    if (!r.ok) throw new Error(`waha presence: HTTP ${r.status}`);
    return { ok: true };
  },

  // ── releaseForMigration ─────────────────────────────────────────────────────
  // Para a sessão + APAGA o creds.json local, SEM deslogar (não desregistra o device).
  async releaseForMigration(ctx, id) {
    const s = String(id);
    await util.httpJson('POST', `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/stop`, { headers: authHeaders(ctx) }).catch(() => {});
    try {
      const p = credsPath(ctx, s);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      util.errlog('[waha] releaseForMigration unlink falhou:', e && e.message);
    }
  },

  // ── restart (regenerar QR) ──────────────────────────────────────────────────
  async restart(ctx, id) {
    const s = String(id);
    await util.httpJson('POST', `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/stop`, { headers: authHeaders(ctx) }).catch(() => {});
    const r = await util.httpJson('POST', `${ctx.apiUrl}/api/sessions/${encodeURIComponent(s)}/start`, { headers: authHeaders(ctx) });
    return { ok: r.ok };
  },

  // ── deleteSession ───────────────────────────────────────────────────────────
  // Para e remove a sessão do WAHA.
  async deleteSession(ctx, id) {
    const s = encodeURIComponent(id);
    await util.httpJson('POST', `${ctx.apiUrl}/api/sessions/${s}/stop`, { headers: authHeaders(ctx) }).catch(() => {});
    await util.httpJson('POST', `${ctx.apiUrl}/api/sessions/${s}/logout`, { headers: authHeaders(ctx) }).catch(() => {});
    const r = await util.httpJson('DELETE', `${ctx.apiUrl}/api/sessions/${s}`, { headers: authHeaders(ctx) });
    if (!r.ok && r.status !== 404) {
      throw new Error(`waha delete: HTTP ${r.status} ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {})}`);
    }
    return { ok: true };
  },

  // ── close ─────────────────────────────────────────────────────────────────────
  async close(_ctx) {
    // no-op (adapter sem pools/clients persistentes).
  },
};
