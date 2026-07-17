'use strict';

/**
 * wuzapi.js — adapter WuzAPI (família whatsmeow) do broker do hub.
 *
 * Suporta os DOIS WuzAPI:
 *   - FORK com import nativo: endpoint POST /session/import-web-creds.
 *   - UPSTREAM asternic/wuzapi: NÃO tem esse endpoint → o import grava direto no Postgres
 *     (whatsmeow_device + users.jid) e conecta via POST /session/connect (Store.ID != nil).
 *   O modo é `ctx.importMode` (env WUZAPI_IMPORT_MODE): 'auto' (default; tenta nativo e cai
 *   p/ SQL em 404/405) | 'native' (só fork) | 'sql' (só upstream). list/qr/export/disconnect/
 *   status são idênticos nos dois (mesmas rotas + mesma store whatsmeow).
 *
 * WuzAPI expõe HTTP + o mesmo Postgres `wuzapi` (tabela `users` + tabelas
 * `whatsmeow_*` do store.Device). Duas camadas de auth:
 *   - /admin/*         → header `token: <WUZAPI_ADMIN_TOKEN>`
 *   - /session/*, /webhook → header `token: <userToken>` (token da instância)
 *
 * ⚠️ WuzAPI usa o header `token` (NÃO `apikey`) → passar via httpJson headers:{token}.
 *
 * ⚠️ Envelope de resposta: os endpoints de sessão passam por s.Respond() e vêm
 * embrulhados em { code, success, data:<payload> } (erro → { code, success:false,
 * error }). Já /admin/users (ListUsers) devolve { instances:[...] } CRU e
 * POST /admin/users (AddUser) devolve { id } CRU — sem envelope. unwrap()/isOk()
 * abaixo cobrem os dois formatos.
 *
 * `id` do adapter = users.id (inteiro). Métodos de sessão resolvem o token da
 * instância via `SELECT token FROM users WHERE id=$1` (pool) e, sem DB, via
 * GET /admin/users.
 */

const crypto = require('crypto');
const passport = require('../lib/passport');
const util = require('../lib/util');

// Import preguiçoso do pg: só é necessário quando WUZAPI_DATABASE_URI estiver setado.
let Pool = null;
function loadPool() {
  if (Pool == null) ({ Pool } = require('pg'));
  return Pool;
}

// ── envelope helpers ──────────────────────────────────────────────────────────
// s.Respond() embrulha em { code, success, data }. unwrap() extrai o payload real
// tanto p/ endpoints embrulhados quanto p/ respostas cruas (admin).
function unwrap(data) {
  // Envelope do WuzAPI: fork = { code, success, data }; upstream asternic = { code, data }.
  if (data && typeof data === 'object' && 'code' in data && 'data' in data) {
    return data.data != null ? data.data : data;
  }
  return data;
}

// Header de auth do ADMIN (/admin/*). Upstream asternic usa `Authorization`; o fork usa
// `token`. Mandamos os DOIS por robustez (o server lê o que checa; o outro é ignorado).
function adminHeaders(ctx) {
  return { Authorization: ctx.adminToken, token: ctx.adminToken };
}

// true se a resposta HTTP foi bem-sucedida considerando o envelope success:false.
function isOk(res) {
  if (!res || !res.ok) return false;
  const d = res.data;
  if (d && typeof d === 'object' && d.success === false) return false;
  return true;
}

// mensagem de erro legível (do envelope ou do corpo).
function errMsg(res) {
  const d = res && res.data;
  if (d && typeof d === 'object') {
    if (d.error) return String(d.error);
    if (d.message) return String(d.message);
  }
  if (typeof d === 'string' && d) return d;
  return `HTTP ${res ? res.status : '?'}`;
}

// ── ctx / pool ────────────────────────────────────────────────────────────────
function stripSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

module.exports = {
  id: 'wuzapi',
  family: 'whatsmeow',

  enabled(env) {
    return !!(env && env.WUZAPI_API_URL && env.WUZAPI_ADMIN_TOKEN);
  },

  async init(env) {
    const apiUrl = stripSlash(env.WUZAPI_API_URL);
    const adminToken = env.WUZAPI_ADMIN_TOKEN;
    let pool = null;
    if (env.WUZAPI_DATABASE_URI) {
      const P = loadPool();
      pool = new P({ connectionString: env.WUZAPI_DATABASE_URI });
    }
    const importMode = (env.WUZAPI_IMPORT_MODE || 'auto').toLowerCase();
    return { apiUrl, adminToken, pool, importMode };
  },

  // ── resolução de token da instância ────────────────────────────────────────
  // Preferência: pool (SELECT token FROM users WHERE id=$1). Sem DB, cai em /admin/users.
  async _resolveToken(ctx, id) {
    if (ctx.pool) {
      const r = await ctx.pool.query('SELECT token FROM users WHERE id=$1', [id]);
      if (r.rows[0] && r.rows[0].token) return r.rows[0].token;
      throw new util.NotSupportedError(`wuzapi: token não encontrado p/ id=${id}`);
    }
    const res = await util.httpJson('GET', `${ctx.apiUrl}/admin/users`, {
      headers: adminHeaders(ctx),
    });
    if (!isOk(res)) throw new Error(`wuzapi list users: ${errMsg(res)}`);
    const arr = normalizeUsers(res.data);
    const found = arr.find((u) => String(u.id) === String(id));
    if (!found || !found.token) throw new util.NotSupportedError(`wuzapi: token não encontrado p/ id=${id}`);
    return found.token;
  },

  // ── _evictUserinfoCache (só UPSTREAM asternic) ──────────────────────────────
  // O auth middleware do asternic cacheia {Id,Jid,Webhook,...} por token com
  // cache.NoExpiration. Se QUALQUER request com o token de usuário toca o middleware
  // ANTES de gravarmos users.jid (na migração o setWebhook roda antes do import; também
  // o disconnect), o cache guarda jid="" — e /session/connect sobe SEM jid
  // ("No jid found. Creating new device" → cicla QR, não relê o device injetado).
  // Não há endpoint de "refresh"; a única evicção não-destrutiva é GET /chat/history:
  // quando History=0 (todo user novo é 0), o handler roda userinfocache.Delete(token)
  // e o próximo request relê o DB. É best-effort: só o efeito colateral importa, o
  // corpo/So código HTTP (501/erro) é irrelevante. No fork com import nativo o import
  // (import-web-creds) já atualiza o cache, então isto só corre no caminho SQL.
  async _evictUserinfoCache(ctx, token) {
    try {
      await util.httpJson('GET', `${ctx.apiUrl}/chat/history`, { headers: { token } });
    } catch (_e) {
      /* a evicção (Delete) já ocorreu no server; ignorar a resposta */
    }
  },

  // ── list ────────────────────────────────────────────────────────────────────
  async list(ctx) {
    const res = await util.httpJson('GET', `${ctx.apiUrl}/admin/users`, {
      headers: adminHeaders(ctx),
    });
    if (!isOk(res)) throw new Error(`wuzapi list: ${errMsg(res)}`);
    const arr = normalizeUsers(res.data);
    const out = [];
    for (const u of arr) {
      const jid = u.jid || '';
      // "conectado" exige device pareado (jid). Sem jid, a sessão foi só criada e ainda
      // não leu QR → não pode aparecer como conectada.
      const connected = !!u.connected && !!jid;
      out.push({
        id: u.id,
        name: u.name || '',
        number: jid ? util.jidToNumber(jid) : '',
        jid,
        status: connected ? 'CONNECTED' : jid ? 'DISCONNECTED' : 'CREATED',
        connected,
      });
    }
    return out;
  },

  // ── qr ──────────────────────────────────────────────────────────────────────
  // ⚠️ SEMPRE connect ANTES do qr/status (senão GetQR/GetStatus dão 500 "No session").
  async qr(ctx, id) {
    const token = await this._resolveToken(ctx, id);
    // 1) connect (idempotente: "Already Connected" também vem 200)
    await util.httpJson('POST', `${ctx.apiUrl}/session/connect`, {
      headers: { token },
      body: { Subscribe: ['All'], Immediate: true },
    });
    // 2) qr
    const qrRes = await util.httpJson('GET', `${ctx.apiUrl}/session/qr`, { headers: { token } });
    const qrData = unwrap(qrRes.data) || {};
    const qr = qrData.QRCode || qrData.qrcode || qrData.qr || '';
    // 3) status (poll curto p/ refletir conexão logo após o connect)
    const st = await this.status(ctx, id).catch(() => ({ connected: false }));
    return { status: st.connected ? 'CONNECTED' : 'DISCONNECTED', qr, code: qr, connected: !!st.connected };
  },

  // ── createSession ───────────────────────────────────────────────────────────
  // [AUDIT] WuzAPI NÃO gera token — o broker fornece. Resposta devolve só { id }.
  // Trata 409 (token colidido) gerando outro e re-tentando 1x.
  async createSession(ctx, name) {
    const attempt = async () => {
      const token = crypto.randomUUID();
      const res = await util.httpJson('POST', `${ctx.apiUrl}/admin/users`, {
        headers: adminHeaders(ctx),
        body: { name, token, events: 'All' },
      });
      return { res, token };
    };
    let { res, token } = await attempt();
    if (res.status === 409) {
      ({ res, token } = await attempt()); // 1 re-tentativa com token novo
    }
    if (!isOk(res)) throw new Error(`wuzapi createSession: ${errMsg(res)}`);
    const body = unwrap(res.data) || {};
    const idVal = body.id != null ? body.id : body.Id;
    if (idVal == null) throw new Error('wuzapi createSession: resposta sem id');
    return { id: idVal, name, token };
  },

  // ── importPassport ──────────────────────────────────────────────────────────
  // FORK: POST /session/import-web-creds (Contrato A cru, exige as 3 públicas).
  // UPSTREAM: sem endpoint → grava direto no Postgres e conecta (ver _importViaSql).
  // ctx.importMode: 'auto' (nativo->SQL em 404/405) | 'native' | 'sql'.
  async importPassport(ctx, id, passportArg) {
    const p = passport.ensurePublics(passportArg);
    const token = await this._resolveToken(ctx, id);
    const mode = ctx.importMode || 'auto';

    if (mode === 'sql') return this._importViaSql(ctx, id, token, p);

    const send = () =>
      util.httpJson('POST', `${ctx.apiUrl}/session/import-web-creds`, { headers: { token }, body: p });

    let res = await send();

    // upstream asternic NÃO registra a rota → cai no FileServer (404) ou 405.
    // Em 'auto', faz o import via SQL direto.
    if ((res.status === 404 || res.status === 405) && mode !== 'native') {
      util.log('wuzapi: /session/import-web-creds ausente (upstream asternic) -> import via SQL direto');
      return this._importViaSql(ctx, id, token, p);
    }

    if (!isOk(res) && /already connected/i.test(errMsg(res))) {
      // sessão viva bloqueia o import → derruba e espera cair.
      await util.httpJson('POST', `${ctx.apiUrl}/session/disconnect`, { headers: { token } }).catch(() => {});
      await util.pollUntil(
        () => this.status(ctx, id),
        (s) => s && s.connected === false,
        { timeoutMs: 20000, intervalMs: 2000 }
      );
      res = await send();
    }
    if (!isOk(res)) throw new Error(`wuzapi importPassport: ${errMsg(res)}`);
    const body = unwrap(res.data) || {};
    const jid = body.jid || (p.me && p.me.id) || '';
    return { ok: true, jid };
  },

  // Import via SQL direto (upstream sem endpoint nativo). Espelha o writeEvoGoDevice do
  // SQL direto: grava whatsmeow_device + vincula users.jid, depois conecta sem QR.
  async _importViaSql(ctx, id, token, p) {
    if (!ctx.pool) {
      throw new Error('wuzapi (upstream): import via SQL exige WUZAPI_DATABASE_URI (acesso ao Postgres)');
    }
    const row = passport.buildDeviceRow(p);
    // ORDEM CRÍTICA (asternic upstream) — validada ao vivo:
    // 1) grava device + users.jid ANTES de tudo: o DB já tem o jid correto quando o
    //    cache for reconstruído.
    await writeWuzapiDevice(ctx.pool, id, row);
    // 2) derruba qualquer cliente rodando (sessão reusada ciclando QR). Best-effort.
    await util.httpJson('POST', `${ctx.apiUrl}/session/disconnect`, { headers: { token } }).catch(() => {});
    // 3) EVICT do userinfocache: setWebhook (migração) / disconnect podem ter cacheado jid=""
    //    antes do passo 1. Sem isto o connect sobe com jid vazio e cicla QR. Ver _evictUserinfoCache.
    await this._evictUserinfoCache(ctx, token);
    // 4) connect sem QR: o cache-miss relê users.jid correto → whatsmeow acha Store.ID != nil
    //    ("Already logged in, just connect") e sobe direto, sem parear.
    const res = await util.httpJson('POST', `${ctx.apiUrl}/session/connect`, {
      headers: { token },
      body: { Subscribe: ['All'], Immediate: true },
    });
    if (!isOk(res) && !/already connected/i.test(errMsg(res))) {
      util.errlog('wuzapi _importViaSql: connect retornou', errMsg(res), '(device gravado; sobe no proximo connect/restart)');
    }
    return { ok: true, jid: row.jid };
  },

  // ── exportPassport ──────────────────────────────────────────────────────────
  // Lê whatsmeow_device (mesmo Postgres wuzapi) → Contrato A (deriva públicas).
  // Sem WUZAPI_DATABASE_URI não há como ler o device → NotSupportedError.
  async exportPassport(ctx, id) {
    if (!ctx.pool) {
      throw new util.NotSupportedError('wuzapi export exige WUZAPI_DATABASE_URI (acesso ao DB)');
    }
    const u = await ctx.pool.query('SELECT jid FROM users WHERE id=$1', [id]);
    const jid = u.rows[0] && u.rows[0].jid;
    if (!jid) throw new util.NotSupportedError(`wuzapi export: users.jid vazio p/ id=${id}`);
    const dev = await ctx.pool.query('SELECT * FROM whatsmeow_device WHERE jid=$1', [jid]);
    const row = dev.rows[0];
    if (!row) throw new util.NotSupportedError(`wuzapi export: whatsmeow_device inexistente p/ jid=${jid}`);
    return { passport: passport.whatsmeowRowToPassport(row) };
  },

  // ── setWebhook ──────────────────────────────────────────────────────────────
  // best-effort (não lança se falhar).
  async setWebhook(ctx, id, url) {
    try {
      const token = await this._resolveToken(ctx, id);
      await util.httpJson('POST', `${ctx.apiUrl}/webhook`, {
        headers: { token },
        body: { webhook: url, events: ['All'] },
      });
    } catch (e) {
      util.errlog('wuzapi setWebhook falhou (best-effort):', e && e.message);
    }
  },

  // ── disconnect ──────────────────────────────────────────────────────────────
  // Para o socket SEM deslogar (mantém creds). NUNCA /session/logout.
  async disconnect(ctx, id) {
    const token = await this._resolveToken(ctx, id);
    const res = await util.httpJson('POST', `${ctx.apiUrl}/session/disconnect`, { headers: { token } });
    // "No session"/"not logged in" = já parado → não é erro fatal p/ o fluxo de migração.
    if (!isOk(res) && !/no session|not connected|not logged in/i.test(errMsg(res))) {
      throw new Error(`wuzapi disconnect: ${errMsg(res)}`);
    }
  },

  // ── status ──────────────────────────────────────────────────────────────────
  async status(ctx, id) {
    const token = await this._resolveToken(ctx, id);
    const res = await util.httpJson('GET', `${ctx.apiUrl}/session/status`, { headers: { token } });
    if (!isOk(res)) {
      // "No session" (500) = cliente não está de pé em memória → não conectado.
      return { connected: false, jid: undefined };
    }
    const d = unwrap(res.data) || {};
    // GetStatus → { Connected, LoggedIn }. "conectado" p/ o hub = socket de pé E logado.
    const isConn = d.Connected != null ? d.Connected : d.connected;
    const loggedIn = d.LoggedIn != null ? d.LoggedIn : d.loggedIn;
    const connected = !!isConn && loggedIn !== false;
    let jid;
    if (ctx.pool) {
      try {
        const u = await ctx.pool.query('SELECT jid FROM users WHERE id=$1', [id]);
        jid = (u.rows[0] && u.rows[0].jid) || undefined;
      } catch (_e) {
        jid = undefined;
      }
    }
    return { connected, jid };
  },

  // ── sendText (teste) ────────────────────────────────────────────────────────
  // Envio de texto p/ validar a sessão. WuzAPI: POST /chat/send/text { Phone, Body }.
  async sendText(ctx, id, to, text) {
    const token = await this._resolveToken(ctx, id);
    const phone = String(to || '').replace(/\D/g, '');
    if (!phone) throw new Error('wuzapi sendText: número inválido');
    const res = await util.httpJson('POST', `${ctx.apiUrl}/chat/send/text`, {
      headers: { token },
      body: { Phone: phone, Body: text },
    });
    if (!isOk(res)) throw new Error(`wuzapi sendText: ${errMsg(res)}`);
    const d = unwrap(res.data) || {};
    return { ok: true, messageId: d.Id || d.id || undefined };
  },

  // ── releaseForMigration ─────────────────────────────────────────────────────
  // Para o socket + APAGA a sessão local (whatsmeow_device + jid), SEM deslogar.
  async releaseForMigration(ctx, id) {
    let token = null;
    try {
      token = await this._resolveToken(ctx, id);
    } catch (_e) {
      /* segue */
    }
    if (token) {
      await util.httpJson('POST', `${ctx.apiUrl}/session/disconnect`, { headers: { token } }).catch(() => {});
    }
    if (ctx.pool) {
      try {
        const u = await ctx.pool.query('SELECT jid FROM users WHERE id=$1', [id]);
        const jid = u.rows[0] && u.rows[0].jid;
        if (jid) await ctx.pool.query('DELETE FROM whatsmeow_device WHERE jid=$1', [jid]);
        await ctx.pool.query("UPDATE users SET jid='', connected=0 WHERE id=$1", [id]);
      } catch (e) {
        util.errlog('[wuzapi] releaseForMigration wipe falhou:', e && e.message);
      }
    }
  },

  // ── restart (regenerar QR) ──────────────────────────────────────────────────
  async restart(ctx, id) {
    const token = await this._resolveToken(ctx, id);
    await util.httpJson('POST', `${ctx.apiUrl}/session/disconnect`, { headers: { token } }).catch(() => {});
    const r = await util.httpJson('POST', `${ctx.apiUrl}/session/connect`, { headers: { token }, body: { Subscribe: ['All'], Immediate: true } });
    return { ok: isOk(r) };
  },

  // ── deleteSession ───────────────────────────────────────────────────────────
  // Remove o usuário/sessão do WuzAPI (admin). /full limpa também o device whatsmeow.
  async deleteSession(ctx, id) {
    let res = await util.httpJson('DELETE', `${ctx.apiUrl}/admin/users/${encodeURIComponent(id)}/full`, { headers: adminHeaders(ctx) });
    if (!isOk(res) && res.status !== 404) {
      res = await util.httpJson('DELETE', `${ctx.apiUrl}/admin/users/${encodeURIComponent(id)}`, { headers: adminHeaders(ctx) });
      if (!isOk(res) && res.status !== 404) throw new Error(`wuzapi delete: ${errMsg(res)}`);
    }
    return { ok: true };
  },

  // ── close ───────────────────────────────────────────────────────────────────
  async close(ctx) {
    if (ctx && ctx.pool) await ctx.pool.end();
  },

  // ── Tier 2: exportStore / importStore (whatsmeow same-family) ───────────────
  // Cópia direta por jid das tabelas whatsmeow_* (mesmo formato — sem re-encode).
  // Idêntico ao evogo (mesma store whatsmeow). Exige acesso ao DB (pool).
  async exportStore(ctx, id) {
    if (!ctx.pool) throw new util.NotSupportedError('wuzapi exportStore exige WUZAPI_DATABASE_URI');
    const u = await ctx.pool.query('SELECT jid FROM users WHERE id=$1', [id]);
    const jid = u.rows[0] && u.rows[0].jid;
    if (!jid) throw new util.NotSupportedError(`wuzapi exportStore: users.jid vazio p/ id=${id}`);

    const blob = { jid, tables: {} };
    for (const t of STORE_TABLES) {
      try {
        const r = await ctx.pool.query(
          `SELECT * FROM ${t.table} WHERE ${t.jidCol}=$1`, // [AUDIT] confirmar colunas de jid por tabela
          [jid]
        );
        blob.tables[t.table] = r.rows;
      } catch (e) {
        util.errlog(`wuzapi exportStore: tabela ${t.table} ignorada:`, e && e.message);
        blob.tables[t.table] = [];
      }
    }
    return blob;
  },

  async importStore(ctx, id, blob) {
    if (!ctx.pool) throw new util.NotSupportedError('wuzapi importStore exige WUZAPI_DATABASE_URI');
    if (!blob || !blob.tables) return;
    const u = await ctx.pool.query('SELECT jid FROM users WHERE id=$1', [id]);
    const jid = u.rows[0] && u.rows[0].jid;
    if (!jid) throw new util.NotSupportedError(`wuzapi importStore: users.jid vazio p/ id=${id}`);

    for (const t of STORE_TABLES) {
      const rows = blob.tables[t.table];
      if (!Array.isArray(rows)) continue;
      try {
        // DELETE por jid do destino + INSERT das linhas do blob (reescrevendo o jid alvo).
        await ctx.pool.query(
          `DELETE FROM ${t.table} WHERE ${t.jidCol}=$1`, // [AUDIT] confirmar colunas de jid por tabela
          [jid]
        );
        for (const row of rows) {
          const src = { ...row, [t.jidCol]: jid };
          const cols = Object.keys(src);
          if (cols.length === 0) continue;
          const params = cols.map((_c, i) => `$${i + 1}`);
          const vals = cols.map((c) => src[c]);
          await ctx.pool.query(
            `INSERT INTO ${t.table} (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${params.join(',')})`,
            vals
          );
        }
      } catch (e) {
        util.errlog(`wuzapi importStore: tabela ${t.table} ignorada:`, e && e.message);
      }
    }
  },
};

// Grava o device whatsmeow + vincula users.jid (caminho UPSTREAM, sem endpoint nativo).
// Colunas do whatsmeow_device (layout do whatsmeow sqlstore).
// [AUDIT] se a versão do whatsmeow do upstream tiver colunas NOT NULL sem default
// (ex.: facebook_uuid/lid_migration_ts), ajustar a lista no teste ao vivo.
async function writeWuzapiDevice(pool, id, row) {
  await pool.query(
    `INSERT INTO whatsmeow_device (
       jid, lid, registration_id, noise_key, identity_key,
       signed_pre_key, signed_pre_key_id, signed_pre_key_sig,
       adv_key, adv_details, adv_account_sig, adv_account_sig_key, adv_device_sig,
       platform, business_name, push_name
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'',$15)
     ON CONFLICT (jid) DO UPDATE SET
       lid = EXCLUDED.lid,
       registration_id = EXCLUDED.registration_id,
       noise_key = EXCLUDED.noise_key,
       identity_key = EXCLUDED.identity_key,
       signed_pre_key = EXCLUDED.signed_pre_key,
       signed_pre_key_id = EXCLUDED.signed_pre_key_id,
       signed_pre_key_sig = EXCLUDED.signed_pre_key_sig,
       adv_key = EXCLUDED.adv_key,
       adv_details = EXCLUDED.adv_details,
       adv_account_sig = EXCLUDED.adv_account_sig,
       adv_account_sig_key = EXCLUDED.adv_account_sig_key,
       adv_device_sig = EXCLUDED.adv_device_sig,
       platform = EXCLUDED.platform,
       push_name = EXCLUDED.push_name`,
    [
      row.jid, row.lid, row.registrationId, row.noiseKey, row.identityKey,
      row.signedPreKey, row.signedPreKeyId, row.signedPreKeySig,
      row.advKey, row.advDetails, row.advAccountSig, row.advAccountSigKey, row.advDeviceSig,
      row.platform, row.pushName,
    ]
  );
  // vincula o usuário ao device. [AUDIT] confirmar tipo da coluna users.connected (int 0/1) no upstream.
  await pool.query('UPDATE users SET jid=$1, connected=1 WHERE id=$2', [row.jid, id]);
}

// Tabelas whatsmeow do store (Tier 2). [AUDIT] confirmar colunas de jid por tabela:
// sessions/sender_keys/identity_keys usam `our_jid`; pre_keys/app_state_* usam `jid`.
const STORE_TABLES = [
  { table: 'whatsmeow_pre_keys', jidCol: 'jid' },
  { table: 'whatsmeow_sessions', jidCol: 'our_jid' },
  { table: 'whatsmeow_sender_keys', jidCol: 'our_jid' },
  { table: 'whatsmeow_app_state_sync_keys', jidCol: 'jid' },
  { table: 'whatsmeow_app_state_version', jidCol: 'jid' },
  { table: 'whatsmeow_identity_keys', jidCol: 'our_jid' },
];

// GET /admin/users devolve { instances:[...] } (ListUsers) OU, dependendo da versão,
// um array cru (ou envelope s.Respond). Normaliza os três p/ um array de
// { id, name, token, jid, connected, events }.
function normalizeUsers(data) {
  const d = unwrap(data);
  const raw = d && typeof d === 'object' && Array.isArray(d.instances) ? d.instances : d;
  return Array.isArray(raw) ? raw : [];
}
