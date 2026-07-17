'use strict';

/**
 * adapters/evogo.js — Evolution Go (whatsmeow) adapter do broker do hub.
 *
 * Evolution Go e whatsmeow oficial (Go) exposto por API REST propria; NAO e Baileys
 * (esse e o adapter `evolution`). Dois bancos Postgres:
 *   authPool  = EVOGO_AUTH_DATABASE_URI  -> tabela whatsmeow_device (+ 7 tabelas de keys)
 *   usersPool = EVOGO_USERS_DATABASE_URI -> tabela instances { id, name, jid, token, connected, qrcode }
 *
 * `id` do EvoGo = UUID da instancia (coluna instances.id).
 *
 * ── MODELO DE AUTH (validado ao vivo) ──
 * Endpoints COM {id} na URL (/instance/info/{id}, /instance/all, /instance/delete/{id}) usam
 * a apikey GLOBAL (env.EVOGO_API_KEY). Endpoints SEM id na URL (connect/status/qr/disconnect/
 * send...) usam apikey = TOKEN POR-INSTANCIA (lido de instances.token). Nao ha header instanceId.
 *
 * ── PASSKEY (whatsmeow) ──
 * /instance/qr pode devolver passkeyStage (conta Meta travada por passkey/CRSC). Quando presente,
 * status='PASSKEY' e o QR nao aparece pelo caminho normal — devolvemos o code/link mesmo assim.
 *
 * ── Contrato A (passaporte) ──
 * O importador (buildDeviceRow) e o exportador (whatsmeowRowToPassport) vivem em lib/passport.js
 * (ja validados vs sqlstore whatsmeow). O device guarda SO a privada 32B; as publicas sao derivadas.
 *
 * ── PEGADINHA anti-colisao ──
 * "evogo".includes("evo") === true. Nunca usar substring includes; comparar tipo por igualdade.
 *
 * ── PEGADINHAS de lifecycle do EvoGo (validadas ao vivo 2026-07-17, sandbox hubtest-zombie) ──
 * 1) /instance/disconnect num cliente CONECTADO mata o cliente MAS o EvoGo AUTO-REINICIA em
 *    ~400ms ("Restarting client") relendo instances.jid — pode ressuscitar com estado stale e
 *    entrar em ciclo de QR (zumbi). Num cliente em modo QR o disconnect e IGNORADO
 *    ("Ignoring disconnect as it was not connected").
 * 2) /instance/connect com cliente vivo (inclusive zumbi de QR) e NO-OP: "Instance already
 *    running, settings updated without restarting client" — NAO rele o device injetado.
 * 3) POST /instance/forcereconnect/{id} (apikey GLOBAL, body { number }) mata QUALQUER cliente
 *    vivo e reinicia relendo o banco — e o unico restart de verdade via HTTP. Com cliente
 *    logado ele recusa ("client already connected"), o que o torna seguro de chamar.
 * 4) DELETE /instance/logout num cliente NAO-logado e inofensivo (nao ha device p/ desregistrar;
 *    "the store doesn't contain a device JID") e tambem mata o cliente. So usar guardado por
 *    LoggedIn=false — logado de verdade, logout DESREGISTRA o companion.
 * O importPassport usa (2)+(3)+(4): connect, espera o login; se nao subiu (zumbi segurando o
 * no-op), forcereconnect; ultimo recurso logout guardado + connect. Sem isso o destino so
 * conectava quando o ciclo de QR esgotava sozinho (5 QRs x 20s ~= 100s depois do import).
 */

const { Pool } = require('pg');
const crypto = require('crypto');

const passport = require('../lib/passport');
const util = require('../lib/util');

const POOL_OPTS = { max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 };

// Colunas do whatsmeow_device gravadas pelo import (ordem = whatsmeow sqlstore).
// business_name fica '' (nao cabe no Contrato A — lossy cosmetico).
const DEVICE_UPSERT_SQL =
  'INSERT INTO whatsmeow_device (' +
  'jid, lid, registration_id, noise_key, identity_key, ' +
  'signed_pre_key, signed_pre_key_id, signed_pre_key_sig, ' +
  'adv_key, adv_details, adv_account_sig, adv_account_sig_key, adv_device_sig, ' +
  'platform, business_name, push_name' +
  ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'',$15) " +
  'ON CONFLICT (jid) DO UPDATE SET ' +
  'lid = EXCLUDED.lid, ' +
  'registration_id = EXCLUDED.registration_id, ' +
  'noise_key = EXCLUDED.noise_key, ' +
  'identity_key = EXCLUDED.identity_key, ' +
  'signed_pre_key = EXCLUDED.signed_pre_key, ' +
  'signed_pre_key_id = EXCLUDED.signed_pre_key_id, ' +
  'signed_pre_key_sig = EXCLUDED.signed_pre_key_sig, ' +
  'adv_key = EXCLUDED.adv_key, ' +
  'adv_details = EXCLUDED.adv_details, ' +
  'adv_account_sig = EXCLUDED.adv_account_sig, ' +
  'adv_account_sig_key = EXCLUDED.adv_account_sig_key, ' +
  'adv_device_sig = EXCLUDED.adv_device_sig, ' +
  'platform = EXCLUDED.platform, ' +
  'push_name = EXCLUDED.push_name';

// ── Tier 2: tabelas de key do whatsmeow copiadas por jid ──────────────────────
// [AUDIT] confirmar nomes de coluna de jid por tabela no schema whatsmeow v14.
// pre_keys/app_state_sync_keys/app_state_version usam `jid`; sessions/sender_keys/
// identity_keys usam `our_jid`. app_state_mutation_macs existe em algumas versoes (por `jid`).
const STORE_TABLES = [
  { table: 'whatsmeow_pre_keys', jidCol: 'jid' },
  { table: 'whatsmeow_sessions', jidCol: 'our_jid' },
  { table: 'whatsmeow_sender_keys', jidCol: 'our_jid' },
  { table: 'whatsmeow_app_state_sync_keys', jidCol: 'jid' },
  { table: 'whatsmeow_app_state_version', jidCol: 'jid' },
  { table: 'whatsmeow_identity_keys', jidCol: 'our_jid' },
  { table: 'whatsmeow_app_state_mutation_macs', jidCol: 'jid' },
];

// Espera o LOGIN real (Connected && LoggedIn) via /instance/status. true se logou.
async function waitLoggedIn(ctx, token, timeoutMs) {
  const read = async () => {
    const res = await util.httpJson('GET', `${ctx.apiUrl}/instance/status`, { apikey: token });
    const s = (res.data && (res.data.data || res.data)) || {};
    return !!(s.Connected && s.LoggedIn);
  };
  const ok = await util.pollUntil(read, (v) => v === true, { timeoutMs, intervalMs: 2000 });
  return ok === true;
}

// Le o token POR-INSTANCIA (necessario p/ ops sem id na URL) + jid conhecido.
async function readInstance(ctx, id) {
  const r = await ctx.usersPool.query(
    'SELECT id, name, jid, token, connected FROM instances WHERE id = $1',
    [id]
  );
  if (!r.rows.length) {
    const e = new Error('INSTANCE_NOT_FOUND');
    e.code = 'INSTANCE_NOT_FOUND';
    throw e;
  }
  return r.rows[0];
}

module.exports = {
  id: 'evogo',
  family: 'whatsmeow',

  enabled(env) {
    return !!(env && env.EVOGO_AUTH_DATABASE_URI && env.EVOGO_USERS_DATABASE_URI);
  },

  async init(env) {
    const apiUrl = String((env && env.EVOGO_API_URL) || '').replace(/\/+$/, '');
    const apiKey = String((env && env.EVOGO_API_KEY) || '');
    const authPool = new Pool({ connectionString: env.EVOGO_AUTH_DATABASE_URI, ...POOL_OPTS });
    const usersPool = new Pool({ connectionString: env.EVOGO_USERS_DATABASE_URI, ...POOL_OPTS });
    return { authPool, usersPool, apiUrl, apiKey };
  },

  // list: instancias vem do usersPool (fonte de verdade do broker). Opcionalmente cruza
  // com GET /instance/all (apikey GLOBAL) p/ status ao vivo, best-effort.
  async list(ctx) {
    const r = await ctx.usersPool.query(
      'SELECT id, name, jid, connected FROM instances ORDER BY name ASC'
    );

    // Cruzamento opcional com a API (id -> connected ao vivo). Falha silenciosa.
    const live = new Map();
    if (ctx.apiUrl && ctx.apiKey) {
      try {
        const res = await util.httpJson('GET', `${ctx.apiUrl}/instance/all`, { apikey: ctx.apiKey });
        const items = Array.isArray(res.data) ? res.data : (res.data && res.data.data) || [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const iid = it && (it.id || it.Id || it.ID);
            if (iid != null) live.set(String(iid), it);
          }
        }
      } catch (_e) {
        // sem cruzamento; usa o banco.
      }
    }

    return r.rows.map((x) => {
      const hit = live.get(String(x.id));
      const connected = hit != null ? !!(hit.connected || hit.Connected) : !!x.connected;
      const jid = (hit && (hit.jid || hit.Jid)) || x.jid || null;
      return {
        id: x.id,
        name: x.name,
        number: util.jidToNumber(jid),
        jid: jid || null,
        status: connected ? 'CONNECTED' : 'DISCONNECTED',
        connected,
      };
    });
  },

  // qr: connect (token da instancia) e depois poll do /instance/qr. Shape real (validado):
  // data.qrcode = imagem (minusculo), data.code = link wa.me, data.passkeyStage = conta travada.
  async qr(ctx, id) {
    const inst = await readInstance(ctx, id);
    const token = inst.token || null;
    if (!token) {
      const e = new Error('INSTANCE_TOKEN_MISSING');
      e.code = 'INSTANCE_TOKEN_MISSING';
      throw e;
    }
    if (!ctx.apiUrl) {
      const e = new Error('EVOGO_API_URL_NOT_CONFIGURED');
      e.code = 'API_URL_MISSING';
      throw e;
    }

    // connect (subscribe vazio; immediate p/ receber o QR na hora).
    try {
      await util.httpJson('POST', `${ctx.apiUrl}/instance/connect`, {
        apikey: token,
        body: { subscribe: [], immediate: true },
      });
    } catch (e) {
      util.errlog('evogo qr connect falhou', id, (e && e.message) || e);
    }

    const readQr = async () => {
      const res = await util.httpJson('GET', `${ctx.apiUrl}/instance/qr`, { apikey: token });
      return (res.data && (res.data.data || res.data)) || {};
    };

    // Poll: para quando houver QR/code/passkey OU quando ja conectar.
    const data = await util.pollUntil(
      readQr,
      (d) => !!(d && (d.qrcode || d.code || d.passkeyStage || d.Connected || d.connected)),
      { timeoutMs: 60000, intervalMs: 2000 }
    );
    const d = data || {};

    const passkeyStage = d.passkeyStage || d.PasskeyStage || null;
    const connected = !!(d.Connected || d.connected || d.LoggedIn);
    const status = passkeyStage ? 'PASSKEY' : connected ? 'CONNECTED' : 'QRCODE';

    return {
      status,
      qr: d.qrcode || d.Qrcode || null,
      code: d.code || d.Code || null,
      connected,
    };
  },

  // createSession: NOS geramos o token (uuid). apikey GLOBAL. Resposta data.id/data.token.
  async createSession(ctx, name) {
    if (!ctx.apiUrl || !ctx.apiKey) {
      const e = new Error('EVOGO_CREATE_NOT_CONFIGURED');
      e.code = 'CREATE_NOT_CONFIGURED';
      throw e;
    }
    const token = crypto.randomUUID();
    const res = await util.httpJson('POST', `${ctx.apiUrl}/instance/create`, {
      apikey: ctx.apiKey,
      body: { name, token },
    });
    const data = (res.data && (res.data.instance || res.data.data)) || res.data || {};
    const newId = data.id;
    if (!res.ok || !newId) {
      const e = new Error('CREATE_FAILED');
      e.code = 'CREATE_FAILED';
      e.detail = res.data;
      throw e;
    }
    return { id: newId, name, token: data.token || token };
  },

  // importPassport: grava device whatsmeow (authPool) + vincula instances.jid (usersPool),
  // depois connect ao vivo (token da instancia). SQL do device = layout do whatsmeow sqlstore.
  async importPassport(ctx, id, passportArg) {
    const inst = await readInstance(ctx, id); // 404 se nao existe
    const p = passport.ensurePublics(passportArg);
    const row = passport.buildDeviceRow(p);
    const token = inst.token || null;

    // Para qualquer cliente rodando ANTES de gravar/conectar: senão o /instance/connect NÃO
    // relê o device injetado e a instância fica CICLANDO QR ("store doesn't contain a device JID").
    if (ctx.apiUrl && token) {
      await util.httpJson('POST', `${ctx.apiUrl}/instance/disconnect`, { apikey: token }).catch(() => {});
    }

    // [FIX] Remove o device ANTIGO desta instância (ex.: :70 stale de um teste anterior) ANTES
    // de gravar o novo. Sem isso o store whatsmeow fica com 2 devices p/ a mesma instância e o
    // connect pode subir o MORTO → LoggedOut → whatsmeow apaga o device + limpa o jid → ciclo de
    // QR. Escopo restrito ao jid que ESTA instância apontava (jids são únicos por companion; não
    // toca devices de outras instâncias). No-op se o jid antigo for vazio ou igual ao novo.
    if (inst.jid && inst.jid !== row.jid) {
      await ctx.authPool
        .query('DELETE FROM whatsmeow_device WHERE jid = $1', [inst.jid])
        .catch((e) => util.errlog('evogo importPassport: limpeza device antigo falhou (segue)', (e && e.message) || e));
    }

    await ctx.authPool.query(DEVICE_UPSERT_SQL, [
      row.jid,
      row.lid,
      row.registrationId,
      row.noiseKey,
      row.identityKey,
      row.signedPreKey,
      row.signedPreKeyId,
      row.signedPreKeySig,
      row.advKey,
      row.advDetails,
      row.advAccountSig,
      row.advAccountSigKey,
      row.advDeviceSig,
      row.platform,
      row.pushName,
    ]);

    await ctx.usersPool.query(
      "UPDATE instances SET jid = $1, connected = true, qrcode = '' WHERE id = $2",
      [row.jid, id]
    );

    // connect FRESCO → GetDevice(jid) → Store.ID != nil → conecta sem QR.
    // [FIX zumbi de QR] Se ja havia cliente vivo em modo QR (ex.: auto-restart pos-disconnect
    // de uma migracao anterior), o connect acima e NO-OP ("already running, without restarting")
    // e o device injetado NUNCA e lido — o destino so subia quando o ciclo de QR esgotava
    // (~100s). Escada de escalada (cada degrau so roda se o login ainda nao subiu):
    //   1. connect + espera login (~8s) — cobre o caso comum (sem cliente vivo).
    //   2. /instance/forcereconnect/{id} (apikey GLOBAL) — unico restart real: mata o zumbi e
    //      rele o banco. Recusa inofensivamente se ja logou ("client already connected").
    //   3. logout (token) GUARDADO por !LoggedIn (sem device local nao desregistra nada) +
    //      connect — replica o self-heal do QR-timeout, na hora.
    if (ctx.apiUrl && token) {
      try {
        await util.httpJson('POST', `${ctx.apiUrl}/instance/connect`, {
          apikey: token,
          body: { subscribe: [], immediate: true },
        });
      } catch (e) {
        util.errlog('evogo importPassport connect falhou', id, (e && e.message) || e);
      }

      let logged = await waitLoggedIn(ctx, token, 8000);

      if (!logged && ctx.apiKey) {
        util.log('evogo importPassport: login nao subiu apos connect — forcereconnect', id);
        await util
          .httpJson('POST', `${ctx.apiUrl}/instance/forcereconnect/${encodeURIComponent(id)}`, {
            apikey: ctx.apiKey,
            body: { number: util.jidToNumber(row.jid) },
            timeoutMs: 20000,
          })
          .catch((e) => util.errlog('evogo importPassport forcereconnect falhou', id, (e && e.message) || e));
        logged = await waitLoggedIn(ctx, token, 10000);
      }

      if (!logged) {
        // Ultimo recurso: logout SO com login ausente (inofensivo sem device; mata o zumbi).
        util.log('evogo importPassport: forcereconnect nao subiu — logout guardado + connect', id);
        await util.httpJson('DELETE', `${ctx.apiUrl}/instance/logout`, { apikey: token }).catch(() => {});
        await util
          .httpJson('POST', `${ctx.apiUrl}/instance/connect`, {
            apikey: token,
            body: { subscribe: [], immediate: true },
          })
          .catch(() => {});
        logged = await waitLoggedIn(ctx, token, 12000);
      }

      util.log('evogo importPassport: destino ' + (logged ? 'LOGADO' : 'ainda sem login (verify do migrate segue)'), id);
    }

    return { ok: true, jid: row.jid };
  },

  // exportPassport: jid vem de instances; a linha completa do device vem do authPool.
  async exportPassport(ctx, id) {
    const inst = await readInstance(ctx, id);
    const jid = inst.jid;
    if (!jid) {
      throw new util.NotSupportedError('EvoGo instancia sem jid (nao pareada) — nada a exportar');
    }
    const r = await ctx.authPool.query('SELECT * FROM whatsmeow_device WHERE jid = $1', [jid]);
    if (!r.rows.length) {
      throw new util.NotSupportedError('whatsmeow_device nao encontrado p/ o jid da instancia');
    }
    return { passport: passport.whatsmeowRowToPassport(r.rows[0]) };
  },

  // setWebhook: connect com subscribe ALL + webhookUrl (token da instancia). Best-effort.
  async setWebhook(ctx, id, url) {
    const inst = await readInstance(ctx, id);
    const token = inst.token || null;
    if (!ctx.apiUrl || !token) return;
    try {
      await util.httpJson('POST', `${ctx.apiUrl}/instance/connect`, {
        apikey: token,
        body: { subscribe: ['ALL'], immediate: true, webhookUrl: url },
      });
    } catch (e) {
      util.errlog('evogo setWebhook falhou', id, (e && e.message) || e);
    }
  },

  // disconnect: para o socket SEM deslogar (mantem o device). NAO usar /instance/logout.
  async disconnect(ctx, id) {
    const inst = await readInstance(ctx, id);
    const token = inst.token || null;
    if (!ctx.apiUrl || !token) return;
    await util.httpJson('POST', `${ctx.apiUrl}/instance/disconnect`, { apikey: token });
  },

  // status: /instance/status (token da instancia) -> { data: { Connected, LoggedIn } }.
  async status(ctx, id) {
    const inst = await readInstance(ctx, id);
    const token = inst.token || null;
    let connected = false;
    if (ctx.apiUrl && token) {
      try {
        const res = await util.httpJson('GET', `${ctx.apiUrl}/instance/status`, { apikey: token });
        const s = (res.data && (res.data.data || res.data)) || {};
        connected = !!(s.Connected && s.LoggedIn);
      } catch (e) {
        util.errlog('evogo status falhou', id, (e && e.message) || e);
      }
    }
    return { connected, jid: inst.jid || null };
  },

  // ── sendText (teste) ────────────────────────────────────────────────────────
  // Envio de texto p/ validar a sessão. EvoGo: POST /send/text (apikey = token da instância).
  async sendText(ctx, id, to, text) {
    const inst = await ctx.usersPool.query('SELECT token FROM instances WHERE id=$1', [id]);
    const token = inst.rows[0] && inst.rows[0].token;
    if (!token) throw new Error(`evogo sendText: token não encontrado p/ id=${id}`);
    const number = String(to || '').replace(/\D/g, '');
    if (!number) throw new Error('evogo sendText: número inválido');
    const r = await util.httpJson('POST', `${ctx.apiUrl}/send/text`, {
      apikey: token,
      body: { number, text, id: crypto.randomUUID() },
    });
    if (!r.ok) throw new Error(`evogo sendText: HTTP ${r.status}`);
    const d = r.data || {};
    return { ok: true, messageId: d.messageId || (d.data && d.data.messageId) || d.id || undefined };
  },

  // ── releaseForMigration ─────────────────────────────────────────────────────
  // Para o socket + APAGA a sessão local (whatsmeow_device + jid), SEM deslogar.
  async releaseForMigration(ctx, id) {
    let jid = null;
    try {
      const inst = await ctx.usersPool.query('SELECT token, jid FROM instances WHERE id=$1', [id]);
      const row = inst.rows[0];
      jid = row && row.jid;
      if (row && row.token) {
        await util.httpJson('POST', `${ctx.apiUrl}/instance/disconnect`, { apikey: row.token }).catch(() => {});
      }
    } catch (e) {
      util.errlog('[evogo] releaseForMigration disconnect falhou:', e && e.message);
    }
    // apaga o device local (CASCADE limpa pre_keys/sessions/...) — NÃO desregistra no WhatsApp.
    if (jid) {
      try {
        await ctx.authPool.query('DELETE FROM whatsmeow_device WHERE jid=$1', [jid]);
      } catch (_e) {
        /* best-effort */
      }
    }
    try {
      await ctx.usersPool.query("UPDATE instances SET jid='', connected=false, qrcode='' WHERE id=$1", [id]);
    } catch (_e) {
      /* best-effort */
    }
  },

  // ── restart (regenerar QR) ──────────────────────────────────────────────────
  // [FIX zumbi de QR] Num cliente em modo QR, disconnect e IGNORADO e connect e NO-OP (ver
  // PEGADINHAS no topo) — restart nao fazia nada. Sem login, logout e inofensivo (nao ha
  // device p/ desregistrar) e MATA o cliente vivo → o connect seguinte parte limpo.
  async restart(ctx, id) {
    const inst = await ctx.usersPool.query('SELECT token FROM instances WHERE id=$1', [id]);
    const token = inst.rows[0] && inst.rows[0].token;
    if (!token) throw new Error(`evogo restart: token não encontrado p/ id=${id}`);
    const st = await util.httpJson('GET', `${ctx.apiUrl}/instance/status`, { apikey: token }).catch(() => null);
    const s = (st && st.data && (st.data.data || st.data)) || {};
    const logged = !!(s.Connected && s.LoggedIn);
    if (logged) {
      await util.httpJson('POST', `${ctx.apiUrl}/instance/disconnect`, { apikey: token }).catch(() => {});
    } else {
      await util.httpJson('DELETE', `${ctx.apiUrl}/instance/logout`, { apikey: token }).catch(() => {});
    }
    const r = await util.httpJson('POST', `${ctx.apiUrl}/instance/connect`, { apikey: token, body: { subscribe: [], immediate: true } });
    return { ok: r.ok };
  },

  // ── deleteSession ───────────────────────────────────────────────────────────
  // Remove a instância do EvoGo. logout (token) best-effort + delete (apikey GLOBAL).
  async deleteSession(ctx, id) {
    try {
      const inst = await ctx.usersPool.query('SELECT token FROM instances WHERE id=$1', [id]);
      const token = inst.rows[0] && inst.rows[0].token;
      if (token) await util.httpJson('POST', `${ctx.apiUrl}/instance/logout`, { apikey: token }).catch(() => {});
    } catch (_e) {
      /* segue p/ delete */
    }
    const r = await util.httpJson('DELETE', `${ctx.apiUrl}/instance/delete/${encodeURIComponent(id)}`, { apikey: ctx.apiKey });
    if (!r.ok && r.status !== 404) throw new Error(`evogo delete: HTTP ${r.status}`);
    return { ok: true };
  },

  async close(ctx) {
    const ends = [ctx.authPool, ctx.usersPool].filter(Boolean).map((p) => p.end());
    await Promise.allSettled(ends);
  },

  // ── Tier 2 (whatsmeow -> whatsmeow): store quente por jid ────────────────────
  // exportStore: dump { tableName: rows[] } das 7 tabelas de key filtradas pelo jid.
  // Tabelas ausentes (versao diferente do schema) sao ignoradas (try/catch).
  async exportStore(ctx, id) {
    const inst = await readInstance(ctx, id);
    const jid = inst.jid;
    if (!jid) {
      throw new util.NotSupportedError('EvoGo instancia sem jid — nada a exportar (store)');
    }
    const blob = {};
    for (const { table, jidCol } of STORE_TABLES) {
      try {
        const r = await ctx.authPool.query(
          `SELECT * FROM ${table} WHERE ${jidCol} = $1`,
          [jid]
        );
        blob[table] = r.rows;
      } catch (e) {
        // tabela ausente/coluna diferente nesta versao do whatsmeow — pula.
        util.errlog('evogo exportStore skip', table, (e && e.message) || e);
      }
    }
    return blob;
  },

  // importStore: para cada tabela do blob, DELETE por jid + INSERT das rows (colunas dinamicas).
  // Colunas descobertas por Object.keys da 1a row -> INSERT parametrizado.
  async importStore(ctx, id, blob) {
    const inst = await readInstance(ctx, id);
    const jid = inst.jid;
    if (!jid) {
      throw new util.NotSupportedError('EvoGo instancia sem jid — nada a importar (store)');
    }
    if (!blob || typeof blob !== 'object') return;

    for (const { table, jidCol } of STORE_TABLES) {
      const rows = Array.isArray(blob[table]) ? blob[table] : null;
      if (!rows) continue; // tabela nao presente no blob
      const client = await ctx.authPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ${table} WHERE ${jidCol} = $1`, [jid]);
        for (const row of rows) {
          const cols = Object.keys(row || {});
          if (!cols.length) continue;
          const placeholders = cols.map((_c, i) => `$${i + 1}`).join(',');
          const quotedCols = cols.map((c) => `"${c}"`).join(',');
          const values = cols.map((c) => row[c]);
          await client.query(
            `INSERT INTO ${table} (${quotedCols}) VALUES (${placeholders})`,
            values
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch (_e) {
          // ignore
        }
        // tabela ausente/schema divergente nesta versao — pula sem abortar a migracao.
        util.errlog('evogo importStore skip', table, (e && e.message) || e);
      } finally {
        client.release();
      }
    }
  },
};
