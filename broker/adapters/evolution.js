'use strict';

/**
 * adapters/evolution.js — adapter Evolution API (v2.3.7, engine Baileys) do broker.
 *
 * Implementa o contrato de adapter congelado (ver broker/lib/passport.js §Contrato)
 * sobre a API HTTP + Postgres do Evolution.
 *
 * ── Identidade ─────────────────────────────────────────────────────────────────
 * O Evolution usa o NOME da instancia como identificador. Aqui `id === name` em
 * TODOS os metodos (list/qr/import/export/status/...). Nao ha id numerico exposto.
 *
 * ── Store (Postgres) ───────────────────────────────────────────────────────────
 *   Instance{ id(cuid), name(unique) }
 *   Session { id, sessionId(FK Instance.id), creds(Text) }
 * `Session.creds` e DUPLO-encode:
 *   coluna = JSON.stringify( JSON.stringify(creds, BufferJSON.replacer) )
 * O encode interno (1x) vem de passport.buildEvoCredsEncoded; embrulhamos +1x aqui.
 *
 * ── Chaves de sinal (Tier 2) ───────────────────────────────────────────────────
 * Evolution NAO guarda pre-key/session/sender-key/app-state em Session.creds — elas
 * vivem no REDIS (CACHE_REDIS_ENABLED). exportStore/importStore mexem no Redis, best-
 * effort (o layout exato das chaves e incerto — ver [AUDIT] em exportStore).
 *
 * ── disconnect ─────────────────────────────────────────────────────────────────
 * [AUDIT] Evolution NAO expoe stop-sem-logout via HTTP (logout DESREGISTRA o device).
 * disconnect e um NO-OP que so loga um aviso (nunca chama /instance/logout).
 */

const crypto = require('crypto');
const { Pool } = require('pg');
const Redis = require('ioredis');
const passport = require('../lib/passport');
const util = require('../lib/util');

// Prefixo garantido no QR base64 (Evolution as vezes devolve cru, sem data-URI).
const PNG_DATA_URI_PREFIX = 'data:image/png;base64,';

function ensurePngDataUri(b64) {
  if (!b64 || typeof b64 !== 'string') return b64 || null;
  const s = b64.trim();
  if (!s) return null;
  if (s.startsWith('data:')) return s;
  return PNG_DATA_URI_PREFIX + s;
}

// fetchInstances e defensivo com o shape: item pode vir flat ou aninhado em {instance:{...}}.
function unwrapInstanceItem(item) {
  if (!item || typeof item !== 'object') return {};
  if (item.instance && typeof item.instance === 'object') return item.instance;
  return item;
}

// Normaliza o campo de status/estado (connectionStatus | state | status) p/ string.
function readState(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const raw =
    obj.connectionStatus != null
      ? obj.connectionStatus
      : obj.state != null
      ? obj.state
      : obj.status != null
      ? obj.status
      : '';
  return String(raw || '').toLowerCase();
}

// JID/numero do dono da instancia (varia por versao: ownerJid | owner | number | jid).
function readOwnerJid(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return String(obj.ownerJid || obj.owner || obj.jid || '') || '';
}
function readNumber(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const jid = readOwnerJid(obj);
  if (jid) return util.jidToNumber(jid);
  if (obj.number != null) return util.jidToNumber(String(obj.number));
  return '';
}

function isSuccessfulEvolutionResponse(response) {
  return Boolean(
    response &&
      response.ok &&
      !(response.data && typeof response.data === 'object' && response.data.error === true)
  );
}

module.exports = {
  id: 'evolution',
  family: 'baileys',

  enabled(env) {
    return !!(env && env.EVO_DATABASE_URI);
  },

  async init(env) {
    const apiUrl = String((env && env.EVO_API_URL) || '').replace(/\/+$/, '');
    const apiKey = String((env && env.EVO_API_KEY) || '');
    const redisUri = String((env && env.EVO_REDIS_URI) || '');
    const redisPrefix = String((env && env.EVO_REDIS_PREFIX) || '');
    // O Evolution cria as tabelas ("Instance"/"Session") no schema `evolution_api`
    // (DATABASE_CONNECTION_URI ?schema=evolution_api). O pg do broker consulta `public`
    // por padrão → "relation Instance does not exist". Setamos o search_path por conexão.
    const schema = String((env && env.EVO_DB_SCHEMA) || 'evolution_api').replace(/[^a-zA-Z0-9_]/g, '');
    const pool = new Pool({
      connectionString: env.EVO_DATABASE_URI,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    if (schema) {
      pool.on('connect', (client) => {
        client.query(`SET search_path TO "${schema}", public`).catch(() => {});
      });
    }
    return { pool, apiUrl, apiKey, redisUri, redisPrefix, redis: null, schema };
  },

  // ── list ──────────────────────────────────────────────────────────────────────
  // GET {apiUrl}/instance/fetchInstances → array (shape defensivo).
  async list(ctx) {
    const r = await util.httpJson('GET', `${ctx.apiUrl}/instance/fetchInstances`, {
      apikey: ctx.apiKey,
    });
    if (!r.ok) {
      util.errlog(`[evolution] fetchInstances status=${r.status}`);
      return [];
    }
    let arr = r.data;
    // pode vir { instances:[...] } ou array direto.
    if (arr && !Array.isArray(arr) && Array.isArray(arr.instances)) arr = arr.instances;
    if (!Array.isArray(arr)) return [];
    return arr.map((raw) => {
      const inst = unwrapInstanceItem(raw);
      const name = String(inst.name || inst.instanceName || '');
      const state = readState(inst);
      const jid = readOwnerJid(inst);
      return {
        id: name,
        name,
        number: readNumber(inst),
        jid: jid || null,
        status: state || 'unknown',
        connected: state === 'open',
      };
    });
  },

  async readiness(ctx) {
    try {
      const r = await util.httpJson('GET', `${ctx.apiUrl}/instance/fetchInstances`, {
        apikey: ctx.apiKey,
      });
      if (!r.ok) return { ok: false, status: r.status };
      const version = String(process.env.EVOLUTION_VERSION || process.env.EVO_VERSION || '2.3.7').replace(/^v/, '');
      return { ok: true, version: `v${version}`, protocolVersion: `v${version}` };
    } catch (_error) {
      return { ok: false };
    }
  },

  // ── qr ────────────────────────────────────────────────────────────────────────
  // GET {apiUrl}/instance/connect/{name} → { base64, code, pairingCode }; estado via connectionState.
  async qr(ctx, id) {
    const name = String(id);
    let base64 = null;
    let code = null;
    try {
      const r = await util.httpJson(
        'GET',
        `${ctx.apiUrl}/instance/connect/${encodeURIComponent(name)}`,
        { apikey: ctx.apiKey }
      );
      const d = (r && r.data) || {};
      base64 = ensurePngDataUri(d.base64 || (d.qrcode && d.qrcode.base64) || null);
      // conteúdo do QR (string "2@...") vs código de pareamento por telefone (curto).
      const qrString = d.code || (d.qrcode && d.qrcode.code) || null;
      code = d.pairingCode || (d.qrcode && d.qrcode.pairingCode) || null;
      // gera um QR PRETO padronizado a partir do conteúdo (a imagem do Evolution vem azulada).
      if (qrString) {
        const black = await util.qrPngDataUri(qrString);
        if (black) base64 = black;
      }
    } catch (e) {
      util.errlog(`[evolution] qr connect falhou name=${name}: ${(e && e.message) || e}`);
    }
    const st = await this.status(ctx, name);
    return {
      status: st.connected ? 'open' : 'connecting',
      qr: base64,
      code,
      connected: st.connected,
    };
  },

  // ── createSession ───────────────────────────────────────────────────────────
  // POST {apiUrl}/instance/create { instanceName, integration:'WHATSAPP-BAILEYS' }.
  async createSession(ctx, name) {
    const nm = String(name || '').trim();
    if (!nm) throw new passport.CredsError('NAME_REQUIRED', 'nome da instancia obrigatorio');
    const existing = (await this.list(ctx)).find((item) => item.id === nm || item.name === nm);
    if (existing) {
      if (existing.connected) {
        throw new passport.CredsError(
          'DESTINATION_ACTIVE',
          `Evolution "${nm}" já está conectada; migração recusada`,
        );
      }
      return { id: nm, name: nm, reused: true };
    }
    const r = await util.httpJson('POST', `${ctx.apiUrl}/instance/create`, {
      apikey: ctx.apiKey,
      body: { instanceName: nm, integration: 'WHATSAPP-BAILEYS' },
    });
    const inst = (r.data && r.data.instance) || {};
    const iname = inst.instanceName || nm;
    if (!r.ok || !inst.instanceName) {
      throw new passport.CredsError(
        'CREATE_FAILED',
        `Evolution /instance/create status=${r.status} detail=${JSON.stringify(r.data)}`
      );
    }
    // id = NOME (Evolution identifica pela instanceName).
    return { id: iname, name: iname };
  },

  // ── importPassport ────────────────────────────────────────────────────────────
  // ensurePublics → buildEvoCredsEncoded → duplo-encode → upsert Session por nome → connect.
  async importPassport(ctx, id, passportDump) {
    const name = String(id);
    const p = passport.ensurePublics(passportDump);
    const missing = passport.passportMissing(p);
    if (missing.length) {
      throw new passport.CredsError('CREDS_INVALID', `faltando: ${missing.join(', ')}`);
    }
    const enc = passport.buildEvoCredsEncoded(p); // encode interno BufferJSON (1x)
    const stored = JSON.stringify(enc); // duplo-encode do Evolution (+1x)

    const client = await ctx.pool.connect();
    try {
      const inst = await client.query('SELECT id FROM "Instance" WHERE name = $1', [name]);
      if (!inst.rows.length) {
        throw new passport.CredsError('INSTANCE_NOT_FOUND', `Instance "${name}" nao existe`);
      }
      const sessionId = inst.rows[0].id;

      const old = await client.query('SELECT creds FROM "Session" WHERE "sessionId" = $1', [
        sessionId,
      ]);
      const oldCreds = old.rows[0] && old.rows[0].creds ? old.rows[0].creds : '';
      util.log(
        `[evolution] import name=${name} sessionId=${sessionId} ` +
          `oldCredsLen=${oldCreds.length} oldCredsSha=${util.shortHash(oldCreds)} newCredsLen=${stored.length}`
      );

      await client.query(
        `INSERT INTO "Session" (id, "sessionId", creds, "createdAt")
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT ("sessionId") DO UPDATE SET creds = EXCLUDED.creds`,
        [crypto.randomUUID(), sessionId, stored]
      );
    } finally {
      client.release();
    }

    // Sobe a sessao ao vivo (sem QR). Se a instancia JA estava rodando/ciclando QR, o
    // /instance/connect NAO relê as creds do banco → forcamos um RESTART (recarrega o auth
    // do DB com as creds injetadas e conecta). A Evolution responde HTTP 200 mesmo quando
    // o controller devolve { error:true }; nesse caso o restart NAO ocorreu e precisamos
    // chamar /connect para criar o cliente lendo as credenciais novas do banco.
    let restart = null;
    try {
      restart = await util.httpJson('POST', `${ctx.apiUrl}/instance/restart/${encodeURIComponent(name)}`, { apikey: ctx.apiKey });
    } catch (error) {
      util.errlog(`[evolution] import restart falhou name=${name}; tentando connect: ${(error && error.message) || error}`);
    }
    if (!isSuccessfulEvolutionResponse(restart)) {
      let connect = null;
      try {
        connect = await util.httpJson('GET', `${ctx.apiUrl}/instance/connect/${encodeURIComponent(name)}`, { apikey: ctx.apiKey });
      } catch (error) {
        throw new passport.CredsError(
          'CONNECT_FAILED',
          `Evolution não iniciou a sessão importada: ${(error && error.message) || error}`
        );
      }
      if (!isSuccessfulEvolutionResponse(connect)) {
        const detail = connect && connect.data ? JSON.stringify(connect.data) : `HTTP ${connect && connect.status}`;
        throw new passport.CredsError('CONNECT_FAILED', `Evolution não iniciou a sessão importada: ${detail}`);
      }
    }

    const jid = p.me && p.me.id ? p.me.id : null;
    return { ok: true, jid };
  },

  // ── exportPassport ────────────────────────────────────────────────────────────
  // SELECT creds da Session (via Instance.name) → parse duplo-encode → Contrato A.
  async exportPassport(ctx, id) {
    const name = String(id);
    const r = await ctx.pool.query(
      `SELECT s.creds AS creds
         FROM "Session" s
         JOIN "Instance" i ON i.id = s."sessionId"
        WHERE i.name = $1`,
      [name]
    );
    if (!r.rows.length || !r.rows[0].creds) {
      throw new passport.CredsError('INSTANCE_NOT_FOUND', `Session de "${name}" nao encontrada`);
    }
    const creds = passport.parseEvolutionCredsColumn(r.rows[0].creds);
    return { passport: passport.baileysCredsToPassport(creds) };
  },

  // ── setWebhook ────────────────────────────────────────────────────────────────
  // POST {apiUrl}/webhook/set/{name}. Best-effort — nunca lanca.
  async setWebhook(ctx, id, webhook) {
    const name = String(id);
    const config = typeof webhook === 'string' ? { url: webhook } : (webhook || {});
    const url = String(config.url || '').trim();
    if (!url) return;
    const headers = {};
    if (typeof config.secret === 'string' && config.secret.length >= 32) {
      headers['X-Mentorian-Evolution-Secret'] = config.secret;
    }
    const r = await util.httpJson(
      'POST',
      `${ctx.apiUrl}/webhook/set/${encodeURIComponent(name)}`,
      {
        apikey: ctx.apiKey,
        body: {
          webhook: {
            enabled: true,
            url,
            headers,
            byEvents: false,
            base64: false,
            events: ['CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
          },
        },
      }
    );
    if (!r.ok) {
      throw new Error(`Evolution setWebhook HTTP ${r.status}`);
    }
    return { ok: true };
  },

  // ── disconnect ────────────────────────────────────────────────────────────────
  // [AUDIT] NO-OP proposital. Evolution nao expoe stop-sem-logout via HTTP; /instance/logout
  // DESREGISTRA o device (exige re-pareamento). Preferimos flapping breve (disponibilidade) a
  // corromper a sessao. Para migrar com seguranca, pare a instancia manualmente na origem.
  // "Desconectar" (botão): Evolution não tem stop-sem-logout via HTTP → faz o LOGOUT do
  // Evolution (encerra a sessão). Para uma instância PRESA em "open" (device já desvinculado
  // no celular) isso DESTRAVA e libera o Ler QR p/ re-parear. NÃO é usado pela migração — a
  // migração usa releaseForMigration (DELETE /instance/delete, sem logout).
  async disconnect(ctx, id) {
    const name = String(id);
    const r = await util.httpJson('DELETE', `${ctx.apiUrl}/instance/logout/${encodeURIComponent(name)}`, { apikey: ctx.apiKey });
    if (!r.ok && r.status !== 404) util.errlog(`[evolution] disconnect(logout) status=${r.status}`);
  },

  // ── status ────────────────────────────────────────────────────────────────────
  // GET {apiUrl}/instance/connectionState/{name} → { connected, jid }.
  async status(ctx, id) {
    const name = String(id);
    try {
      const r = await util.httpJson(
        'GET',
        `${ctx.apiUrl}/instance/connectionState/${encodeURIComponent(name)}`,
        { apikey: ctx.apiKey }
      );
      const inst = unwrapInstanceItem((r && r.data) || {});
      const state = readState(inst);
      const jid = readOwnerJid(inst) || null;
      return { connected: state === 'open', jid };
    } catch (e) {
      util.errlog(`[evolution] status falhou name=${name}: ${(e && e.message) || e}`);
      return { connected: false, jid: null };
    }
  },

  // ── sendText (teste) ────────────────────────────────────────────────────────
  // Envio de texto p/ validar a sessão (ex.: após migrar). Evolution v2: /message/sendText/{instance}.
  async sendText(ctx, id, to, text) {
    const number = String(to || '').replace(/\D/g, '');
    if (!number) throw new Error('evolution sendText: número inválido');
    const r = await util.httpJson('POST', `${ctx.apiUrl}/message/sendText/${encodeURIComponent(id)}`, {
      apikey: ctx.apiKey,
      body: { number, text },
    });
    if (!r.ok) {
      throw new Error(`evolution sendText: HTTP ${r.status} ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {})}`);
    }
    const d = r.data || {};
    return { ok: true, messageId: (d.key && d.key.id) || d.id || undefined };
  },

  async sendMedia(ctx, id, input) {
    const number = String(input && input.to || '').replace(/\D/g, '');
    const mediaUrl = String(input && input.mediaUrl || '').trim();
    const kind = String(input && input.kind || 'document');
    if (!number || !mediaUrl.startsWith('https://')) {
      throw new Error('evolution sendMedia: número ou URL inválida');
    }
    const mediatype = kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : kind === 'image' ? 'image' : 'document';
    const r = await util.httpJson(
      'POST',
      `${ctx.apiUrl}/message/sendMedia/${encodeURIComponent(id)}`,
      {
        apikey: ctx.apiKey,
        body: {
          number,
          mediatype,
          mimetype: String(input && input.mimeType || 'application/octet-stream'),
          caption: String(input && input.caption || ''),
          fileName: String(input && input.fileName || `arquivo-${Date.now()}`),
          media: mediaUrl,
        },
      },
    );
    if (!r.ok) throw new Error(`evolution sendMedia: HTTP ${r.status}`);
    const d = r.data || {};
    return { ok: true, messageId: (d.key && d.key.id) || d.id || undefined };
  },

  async setPresence(ctx, id, to, state) {
    const number = String(to || '').replace(/\D/g, '');
    if (!number) throw new Error('evolution presence: número inválido');
    const r = await util.httpJson(
      'POST',
      `${ctx.apiUrl}/chat/sendPresence/${encodeURIComponent(id)}`,
      {
        apikey: ctx.apiKey,
        body: {
          number,
          presence: state === 'composing' ? 'composing' : 'paused',
          delay: state === 'composing' ? 1200 : 0,
        },
      },
    );
    if (!r.ok) throw new Error(`evolution presence: HTTP ${r.status}`);
    return { ok: true };
  },

  // ── releaseForMigration ─────────────────────────────────────────────────────
  // Libera o companion p/ MIGRAÇÃO **SEM DESREGISTRAR** o device no WhatsApp.
  // [AUDIT CONFIRMADO AO VIVO] /instance/delete E /instance/logout do Evolution DESLOGAM
  // o device (o WhatsApp manda LoggedOut → mata a sessão migrada). Então NÃO chamamos
  // nenhum dos dois. Em vez disso, apagamos só as CREDS LOCAIS da Session: o cliente vivo
  // perde o slot p/ o destino (multi-device replace); ao tentar reconectar não acha creds
  // → vai p/ QR, sem segurar o device. O device segue REGISTRADO e a sessão sobrevive.
  async releaseForMigration(ctx, id) {
    const name = String(id);
    // 1) apaga as creds locais da Session (sem deslogar/desregistrar).
    try {
      await ctx.pool.query(
        'DELETE FROM "Session" WHERE "sessionId" = (SELECT id FROM "Instance" WHERE name = $1)',
        [name]
      );
    } catch (e) {
      util.errlog('[evolution] releaseForMigration wipe-creds falhou:', e && e.message);
    }
    // 2) RESTART força o cliente Baileys vivo a RELER o DB (agora sem creds) → cai p/ estado
    //    QR, LARGANDO o slot do device — SEM deslogar. Sem isso o cliente vivo mantém as creds
    //    em memória, reconecta e continua segurando o companion (destino não assume).
    try {
      await util.httpJson('POST', `${ctx.apiUrl}/instance/restart/${encodeURIComponent(name)}`, {
        apikey: ctx.apiKey,
      });
    } catch (e) {
      util.errlog('[evolution] releaseForMigration restart falhou:', e && e.message);
    }
  },

  // ── restart (regenerar QR) ──────────────────────────────────────────────────
  async restart(ctx, id) {
    const r = await util.httpJson('GET', `${ctx.apiUrl}/instance/connect/${encodeURIComponent(id)}`, { apikey: ctx.apiKey });
    return { ok: r.ok };
  },

  // ── deleteSession ───────────────────────────────────────────────────────────
  // Remove a instância do Evolution (logout best-effort + delete).
  async deleteSession(ctx, id) {
    const name = encodeURIComponent(id);
    const del = () => util.httpJson('DELETE', `${ctx.apiUrl}/instance/delete/${name}`, { apikey: ctx.apiKey });
    const logout = () => util.httpJson('DELETE', `${ctx.apiUrl}/instance/logout/${name}`, { apikey: ctx.apiKey }).catch(() => {});
    // Evolution NÃO deleta instância conectada ("open") → logout primeiro e esperar cair.
    await logout();
    await util.pollUntil(() => this.status(ctx, id), (s) => !s || !s.connected, { timeoutMs: 6000, intervalMs: 1500 });
    let r = await del();
    if (!r.ok && r.status !== 404) {
      // ainda conectado/estado transitório → repete logout + delete uma vez.
      await logout();
      await util.pollUntil(() => this.status(ctx, id), (s) => !s || !s.connected, { timeoutMs: 6000, intervalMs: 1500 });
      r = await del();
    }
    if (!r.ok && r.status !== 404) {
      throw new Error(`evolution delete: HTTP ${r.status} ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {})}`);
    }
    return { ok: true };
  },

  // ── close ─────────────────────────────────────────────────────────────────────
  async close(ctx) {
    const jobs = [];
    if (ctx && ctx.pool) jobs.push(ctx.pool.end());
    if (ctx && ctx.redis) {
      try {
        jobs.push(ctx.redis.quit());
      } catch (_e) {
        /* ignore */
      }
    }
    await Promise.allSettled(jobs);
  },

  // ── Tier 2 (mesma-familia baileys) ─────────────────────────────────────────────
  // As chaves de sinal do Evolution vivem no REDIS, nao em Session.creds.
  // [AUDIT] confirmar padrao de chaves do Evolution no Redis no teste ao vivo.

  // Abre (lazy) e cacheia a conexao Redis no ctx. null se EVO_REDIS_URI ausente.
  _getRedis(ctx) {
    if (!ctx.redisUri) return null;
    if (ctx.redis) return ctx.redis;
    ctx.redis = new Redis(ctx.redisUri, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      keyPrefix: ctx.redisPrefix || undefined,
    });
    return ctx.redis;
  },

  // exportStore: SCAN por substring dos tipos de chave de sinal e devolve { key: value }.
  async exportStore(ctx, id) {
    const name = String(id);
    const redis = this._getRedis(ctx);
    if (!redis) {
      util.log(`[evolution] exportStore(${name}) NO-OP: EVO_REDIS_URI ausente (Tier 2 indisponivel).`);
      return {};
    }

    // [AUDIT] confirmar padrao de chaves do Evolution no Redis no teste ao vivo.
    // O layout exato e INCERTO — filtramos por SUBSTRING dos tipos conhecidos (defensivo).
    const typeSubstrings = [
      'pre-key',
      'prekey',
      'session',
      'sender-key',
      'senderkey',
      'app-state-sync-key',
      'app-state-sync-version',
      'appstate',
    ];
    const nameLc = name.toLowerCase();

    const out = {};
    let scanned = 0;
    let copied = 0;
    let cursor = '0';
    do {
      // MATCH generoso (*name*) reduz o universo antes do filtro fino por substring de tipo.
      const [next, keys] = await redis.scan(cursor, 'MATCH', `*${name}*`, 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        scanned += 1;
        const kLc = String(key).toLowerCase();
        // exige o nome da instancia + um dos tipos de chave de sinal.
        if (!kLc.includes(nameLc)) continue;
        if (!typeSubstrings.some((t) => kLc.includes(t))) continue;
        try {
          const val = await redis.get(key);
          if (val != null) {
            out[key] = val;
            copied += 1;
          }
        } catch (_e) {
          /* chave pode nao ser string (hash/set) — ignora no best-effort */
        }
      }
    } while (cursor !== '0');

    util.log(`[evolution] exportStore(${name}): ${copied} chaves copiadas (de ${scanned} varridas).`);
    return out;
  },

  // importStore: MSET de volta o blob {key:value}. Best-effort.
  async importStore(ctx, id, blob) {
    const name = String(id);
    const redis = this._getRedis(ctx);
    if (!redis) {
      util.log(`[evolution] importStore(${name}) NO-OP: EVO_REDIS_URI ausente (Tier 2 indisponivel).`);
      return;
    }
    if (!blob || typeof blob !== 'object') {
      util.log(`[evolution] importStore(${name}): blob vazio/invalido, nada a fazer.`);
      return;
    }
    // [AUDIT] confirmar padrao de chaves do Evolution no Redis no teste ao vivo.
    const entries = Object.entries(blob).filter(([k, v]) => k != null && v != null);
    if (!entries.length) {
      util.log(`[evolution] importStore(${name}): 0 pares validos.`);
      return;
    }
    const flat = [];
    for (const [k, v] of entries) flat.push(String(k), String(v));
    try {
      await redis.mset(...flat);
      util.log(`[evolution] importStore(${name}): ${entries.length} chaves restauradas via MSET.`);
    } catch (e) {
      util.errlog(`[evolution] importStore(${name}) MSET falhou: ${(e && e.message) || e}`);
    }
  },
};
