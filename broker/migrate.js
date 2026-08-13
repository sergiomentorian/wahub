'use strict';

/**
 * migrate.js — orquestrador da migração 1-clique do hub.
 *
 * Move o MESMO companion device do WhatsApp de uma API para outra SEM re-parear:
 *   status(origem) -> DISCONNECT(origem) -> verify-down -> EXPORT(origem) ->
 *   [criar destino] -> IMPORT(destino) -> [Tier2 store] -> webhook(destino) ->
 *   verify-up(destino) -> [rollback|cleanup].
 *
 * Tudo passa pelo Contrato A (passaporte) via os adapters congelados. Este módulo
 * é agnóstico de família: só encadeia os métodos do adapter e aplica as guardas.
 *
 * ── [AUDIT] Guardas obrigatórias ───────────────────────────────────────────────
 *  - LOCK por-número (mutex em memória): duas migrações no MESMO número nunca correm
 *    juntas (`locks` Set, chave = jid->dígitos). Liberado sempre no finally.
 *  - DEDUP por número: recusa se o número já estiver conectado em OUTRA API (que não
 *    seja o destino escolhido) — evita dois backends disputando o mesmo companion.
 *  - DISCONNECT + VERIFY-DOWN: matar o cliente vivo da origem e CONFIRMAR que caiu
 *    antes de conectar o destino. O cliente vivo NÃO relê o DB; se ficar de pé, o
 *    servidor chuta a origem e ela reconecta sozinha => FLAPPING. (Evolution
 *    disconnect pode ser no-op → aceitamos e seguimos, só logamos aviso.)
 *  - WEBHOOK DEPOIS do import: registrar o webhook do destino DEPOIS de injetar as
 *    creds/subir o device (best-effort — não aborta a migração). Antes rodava ANTES do
 *    import, mas o setWebhook do EvoGo faz /instance/connect e, no destino recém-criado
 *    ainda apontando p/ um jid ANTIGO, isso subia um companion morto → LoggedOut → ciclo
 *    de QR. Os outros adapters têm setWebhook = escrita de config pura (ordem indiferente).
 *  - TIER 2 SÓ MESMA-FAMÍLIA: store completo (7 tabelas whatsmeow / creds+keys
 *    baileys) só quando origem e destino são da mesma família E ambos expõem
 *    export/importStore. Cross-família cai para Tier 1 (creds-only, self-heal).
 *  - NUNCA logout: disconnect/stop mantêm as creds; logout DESREGISTRA o companion
 *    no servidor (mata em todo lugar, exige re-pareamento). cleanup jamais desloga.
 */

const util = require('./lib/util');
const passport = require('./lib/passport');

// Erro tipado da migração — carrega o code de negócio + o status HTTP que o index
// deve devolver. run() só lança MigrateError; erros inesperados sobem como Error cru
// (o index os mapeia p/ 500).
class MigrateError extends Error {
  constructor(code, msg) {
    super(msg || code);
    this.name = 'MigrateError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 500;
  }
}

const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  SOURCE_EXPORT_UNSUPPORTED: 400,
  SOURCE_NOT_READY: 400,
  SOURCE_RELEASE_FAILED: 502,
  LOCKED: 409,
  NUMBER_ALREADY_CONNECTED: 409,
  DESTINATION_NOT_READY: 502,
};

// [AUDIT] LOCK por-número em memória do módulo (mutex de processo). Chave = número
// (jid->dígitos). Persiste enquanto o processo vive; liberado no finally de run().
const locks = new Set();

// Resolve uma entry do registry por id EXATO (evogo != evo — nunca includes).
function resolveEntry(registry, api) {
  const entry = registry && registry[api];
  if (!entry || !entry.adapter || entry.ctx === undefined) return null;
  return entry;
}

async function run(registry, body) {
  const b = body || {};
  const from = b.from || {};
  const to = b.to || {};
  const tier = b.tier != null ? Number(b.tier) : 1;
  const cleanup = b.cleanup === true;
  const webhookUrl = b.webhookUrl;

  // ── Validação de forma ───────────────────────────────────────────────────────
  if (!from.api || !from.id) {
    throw new MigrateError('BAD_REQUEST', 'from.api e from.id são obrigatórios');
  }
  if (!to.api) {
    throw new MigrateError('BAD_REQUEST', 'to.api é obrigatório');
  }
  if (!to.id && !to.name) {
    throw new MigrateError('BAD_REQUEST', 'to.id ou to.name é obrigatório');
  }

  const fromEntry = resolveEntry(registry, from.api);
  if (!fromEntry) {
    throw new MigrateError('BAD_REQUEST', `from.api desconhecida: ${from.api}`);
  }
  const toEntry = resolveEntry(registry, to.api);
  if (!toEntry) {
    throw new MigrateError('BAD_REQUEST', `to.api desconhecida: ${to.api}`);
  }

  const fromAdapter = fromEntry.adapter;
  const fromCtx = fromEntry.ctx;
  const toAdapter = toEntry.adapter;
  const toCtx = toEntry.ctx;

  const steps = [];
  const push = (step, detail) => {
    steps.push(detail !== undefined ? { step, detail } : { step });
    util.log('migrate step', step, detail !== undefined ? detail : '');
  };

  // ── PASSO 1: status origem + derivar número + LOCK + DEDUP ─────────────────────
  const st = await fromAdapter.status(fromCtx, from.id);
  const number = util.jidToNumber(st && st.jid);
  push('status-origem', 'origem ' + (st && st.connected ? 'conectada' : 'desconectada') + (number ? ', numero ' + number : ''));

  // [AUDIT] LOCK por-número: se já há migração no mesmo número em curso, recusa.
  // Só travamos quando conseguimos derivar um número — sem jid não há chave de lock
  // confiável (nem de dedup); seguimos sem trava nesse caso de borda.
  let lockKey = null;
  let sourceReleased = false;
  let toId = to.id || null;
  let destinationCreated = false;
  if (number) {
    if (locks.has(number)) {
      throw new MigrateError('LOCKED', `migração já em andamento para o número ${number}`);
    }
    locks.add(number);
    lockKey = number;
  }

  try {
    // [AUDIT] DEDUP por número: o mesmo companion não pode estar conectado em duas
    // APIs. Varre o registry (exceto o par from/to) chamando list(); se ACHAR outra
    // sessão connected===true com o MESMO número, recusa. A única exceção é o próprio
    // destino escolhido (to) — para lá é justamente que queremos migrar.
    // Custo: 1 list() por API extra (rede/DB). Aceitável na v1 (poucas APIs); ver TODO.
    if (number) {
      // Lista as OUTRAS APIs em PARALELO (bounded pelo mais lento, não pela soma) —
      // uma API fora do ar não bloqueia nem trava o dedup.
      const others = Object.keys(registry).filter((k) => k !== from.api && k !== to.api);
      const lists = await Promise.all(
        others.map(async (key) => {
          const entry = registry[key];
          if (!entry || !entry.adapter) return { key, items: [] };
          try {
            return { key, items: (await entry.adapter.list(entry.ctx)) || [] };
          } catch (e) {
            util.errlog('dedup: list falhou em', key, e && e.message);
            return { key, items: [] };
          }
        })
      );
      for (const { key, items } of lists) {
        for (const it of items) {
          if (!it || it.connected !== true) continue;
          const itNumber = it.number || util.jidToNumber(it.jid);
          if (itNumber && itNumber === number) {
            throw new MigrateError(
              'NUMBER_ALREADY_CONNECTED',
              `número ${number} já conectado em ${key} (id=${it.id})`
            );
          }
        }
      }
    }

    // ── PASSO 2: EXPORT origem (passaporte + store Tier 2) ──────────────────────
    // [AUDIT] Lemos TUDO da origem AGORA, ANTES de liberá-la — o PASSO 4 vai LIMPAR a
    // sessão local dela. uazapi (destino-only) lança NotSupportedError.
    let pass;
    try {
      const res = await fromAdapter.exportPassport(fromCtx, from.id);
      pass = res && res.passport;
    } catch (e) {
      if (e instanceof util.NotSupportedError || (e && e.code === 'NOT_SUPPORTED')) {
        throw new MigrateError('SOURCE_EXPORT_UNSUPPORTED', `${from.api} não suporta export (destino-only)`);
      }
      // Qualquer outra falha no export = origem sem sessão/creds válidas p/ migrar.
      throw new MigrateError(
        'SOURCE_NOT_READY',
        `origem ${from.api} sem sessão para migrar — conecte/pareie a origem primeiro (${(e && e.message) || e})`
      );
    }
    if (!pass) {
      throw new MigrateError('SOURCE_EXPORT_UNSUPPORTED', `${from.api} não retornou passaporte`);
    }
    const passReady = passport.ensurePublics(pass);

    // Tier 2 (SÓ mesma-família): lê o store completo da origem AGORA (antes do wipe).
    const sameFamily = fromAdapter.family === toAdapter.family;
    const hasStore =
      typeof fromAdapter.exportStore === 'function' && typeof toAdapter.importStore === 'function';
    let storeBlob = null;
    if (tier === 2 && sameFamily && hasStore) {
      try {
        storeBlob = await fromAdapter.exportStore(fromCtx, from.id);
      } catch (e) {
        util.errlog('migrate: exportStore falhou (segue Tier 1)', e && e.message);
        storeBlob = null;
      }
    }
    push('export');

    // ── PASSO 3: criar destino se preciso ───────────────────────────────────────
    if (!toId) {
      const c = await toAdapter.createSession(toCtx, to.name);
      toId = c && c.id;
      if (!toId) {
        throw new MigrateError('BAD_REQUEST', `createSession em ${to.api} não retornou id`);
      }
      destinationCreated = true;
      push('create', 'destino criado: ' + toId);
    }

    // ── PASSO 4: LIBERAR a origem (parar + LIMPAR a sessão local, SEM deslogar) ──
    // [AUDIT] Crítico: senão a origem continua segurando o companion e o destino fica
    // degradado/erra ao enviar (as duas "conectadas"). releaseForMigration para o socket
    // E APAGA a sessão local da origem (device/creds) — NUNCA logout (não desregistra o
    // device no WhatsApp). Também impede a origem de reconectar/reabrir QR com a sessão
    // antiga. Sem esse método (borda), cai no disconnect (só para o socket).
    if (typeof fromAdapter.releaseForMigration === 'function') {
      try {
        await fromAdapter.releaseForMigration(fromCtx, from.id);
        sourceReleased = true;
        push('release-origem', 'origem parada e sessão local limpa (sem deslogar)');
      } catch (e) {
        if (from.api === 'mentorian') {
          throw new MigrateError(
            'SOURCE_RELEASE_FAILED',
            `Baileys não confirmou a pausa; migração cancelada antes de importar no WAHA (${(e && e.message) || e})`
          );
        }
        util.errlog('migrate: releaseForMigration falhou (segue)', e && e.message);
        push('release-origem', 'falha ao liberar origem (segue): ' + (e && e.message));
      }
    } else {
      try {
        await fromAdapter.disconnect(fromCtx, from.id);
        sourceReleased = true;
      } catch (_e) {
        /* best-effort */
      }
      push('release-origem', 'origem desconectada');
    }
    // verify-down curto: confirma que a origem caiu antes de conectar o destino.
    await util.pollUntil(
      () => fromAdapter.status(fromCtx, from.id),
      (s) => !s || !s.connected,
      { timeoutMs: 8000, intervalMs: 2000 }
    );

    // ── PASSO 5: IMPORT no destino (grava as creds + dispara o connect) ─────────
    const imp = await toAdapter.importPassport(toCtx, toId, passReady);
    push('import', imp && imp.jid ? 'importado: ' + imp.jid : 'importado');

    // ── PASSO 6: Tier 2 — grava o store completo no destino (blob lido no PASSO 2) ──
    if (tier === 2) {
      if (storeBlob && hasStore) {
        try {
          await toAdapter.importStore(toCtx, toId, storeBlob);
          push('tier2-store', 'store completo copiado (Tier 2)');
        } catch (e) {
          util.errlog('migrate: Tier 2 importStore falhou (segue Tier 1)', e && e.message);
          push('tier2-store', 'Tier 2 falhou, segue Tier 1: ' + (e && e.message));
        }
      } else if (!sameFamily) {
        push('tier2-skipped-crossfamily');
      } else {
        push('tier2-skipped-unsupported');
      }
    }

    // ── PASSO 7: WEBHOOK no destino — DEPOIS do import (não antes) ──────────────
    // [FIX] O setWebhook do EvoGo faz /instance/connect. Rodando ANTES do import, ele
    // conectava a instância recém-criada quando ela ainda apontava p/ um jid ANTIGO
    // (device stale de teste anterior / vazio) → subia um companion morto → LoggedOut →
    // limpava o jid e entrava em ciclo de QR que corria com o import (destino nunca
    // estabilizava). DEPOIS do import, o connect do webhook sobe o device recém-injetado
    // (correto) com subscribe ALL. Os outros 4 adapters têm setWebhook = escrita de config
    // pura (não conecta), então a ordem lhes é indiferente.
    if (webhookUrl) {
      try {
        await toAdapter.setWebhook(toCtx, toId, webhookUrl);
        push('webhook', 'webhook registrado no destino');
      } catch (e) {
        util.errlog('migrate: setWebhook falhou (best-effort)', e && e.message);
        push('webhook', 'webhook falhou (best-effort): ' + (e && e.message));
      }
    }

    // ── PASSO 8: VERIFY destino ─────────────────────────────────────────────────
    const ok = await util.pollUntil(
      () => toAdapter.status(toCtx, toId),
      (s) => s && s.connected,
      { timeoutMs: from.api === 'mentorian' ? 90000 : 25000, intervalMs: 3000 }
    );
    const connected = !!(ok && ok.connected);
    push('verify', connected ? 'destino conectado' : 'destino não confirmou conexão');
    if (!connected) {
      throw new MigrateError(
        'DESTINATION_NOT_READY',
        'WAHA não confirmou a sessão; a origem será restaurada automaticamente'
      );
    }

    if (typeof fromAdapter.commitMigration === 'function') {
      await fromAdapter.commitMigration(fromCtx, from.id, {
        api: to.api,
        id: toId,
      });
      push('commit-origem', 'WAHA assumiu a sessão; restauração automática do Baileys bloqueada');
    }

    return {
      success: true,
      connected,
      jid: imp && imp.jid,
      from: { api: from.api, id: from.id },
      to: { api: to.api, id: toId },
      tier,
      steps,
    };
  } catch (error) {
    if (!sourceReleased && destinationCreated && toId) {
      try {
        if (typeof toAdapter.releaseForMigration === 'function') {
          await toAdapter.releaseForMigration(toCtx, toId);
        }
      } catch (cleanupError) {
        util.errlog('migrate: limpeza do destino vazio falhou', cleanupError && cleanupError.message);
      }
    }
    if (sourceReleased) {
      try {
        if (toId && typeof toAdapter.releaseForMigration === 'function') {
          await toAdapter.releaseForMigration(toCtx, toId);
        }
      } catch (cleanupError) {
        util.errlog('migrate: limpeza do destino falhou no rollback', cleanupError && cleanupError.message);
      }
      try {
        if (typeof fromAdapter.rollbackMigration === 'function') {
          await fromAdapter.rollbackMigration(fromCtx, from.id);
          push('rollback-origem', 'Baileys restaurado automaticamente');
        }
      } catch (rollbackError) {
        util.errlog('migrate: rollback da origem falhou', rollbackError && rollbackError.message);
      }
    }
    throw error;
  } finally {
    // Sempre liberar o lock — inclusive em erro/rollback.
    if (lockKey) locks.delete(lockKey);
  }
}

module.exports = { run, MigrateError, locks };
