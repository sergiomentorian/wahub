'use strict';

/**
 * passport.js — codec canônico do hub.
 *
 * O "passaporte" (Contrato A) é o IR único por onde TODO import/export/migração
 * passa. Este módulo converte:
 *
 *   Contrato A  <->  Baileys AuthenticationCreds     (Evolution API, WAHA NOWEB)
 *   Contrato A  <->  linha whatsmeow_device          (Evolution Go, WuzAPI, WAHA GOWS)
 *
 * ── DERIVAÇÃO DE CHAVE PÚBLICA (crítico — validado na auditoria 2026-07-16) ──
 * O whatsmeow_device guarda SÓ a chave PRIVADA (32B) de noise/identity/signedPreKey;
 * a pública é derivada no load via curve25519.ScalarBaseMult. O Baileys guarda o par.
 * Como o Contrato A é o IR e os importadores NATIVOS (WuzAPI /session/import-web-creds,
 * UAZAPI /instance/import-creds) EXIGEM as públicas (400 sem elas), o exportador tem
 * que SEMPRE derivar as 3 públicas — para TODOS os destinos, não só Baileys.
 *
 * A derivação é X25519 scalar-base-mult (pub = ScalarBaseMult(priv)) e reproduz os
 * bytes EXATOS que whatsmeow/Baileys esperam (clamping é interno ao X25519; sem trap
 * de 0x05/Edwards). Feita com o crypto nativo do Node (sem dependência extra).
 *
 * accountSignatureKey NÃO é derivável (é a chave do APARELHO primário) → ler crua.
 * signedPreKey.signature é copiada, NUNCA re-assinada (XEdDSA é não-determinística).
 *
 * ── Contrato de adapter (congelado — todos os adapters seguem) ──────────────
 * Cada adapter (broker/adapters/<api>.js) exporta:
 *   id: string                                  // 'evolution'|'evogo'|'wuzapi'|'waha'|'uazapi'
 *   family: 'baileys'|'whatsmeow'
 *   enabled(env): boolean
 *   async init(env): ctx                        // cria pools/clients; guardado pelo index
 *   async list(ctx): [{ id, name, number, jid, status, connected }]
 *   async qr(ctx, id): { status, qr, code, connected }
 *   async createSession(ctx, name): { id, name }
 *   async importPassport(ctx, id, passport): { ok, jid }   // grava + conecta
 *   async exportPassport(ctx, id): { passport }            // ou throw NotSupportedError
 *   async setWebhook(ctx, id, url): void
 *   async disconnect(ctx, id): void             // para o socket SEM deslogar (mantém creds)
 *   async status(ctx, id): { connected }
 *   async close(ctx): void
 *   // Tier 2 (opcional, só mesma-família):
 *   async exportStore?(ctx, id): storeBlob
 *   async importStore?(ctx, id, storeBlob): void
 */

const crypto = require('crypto');

// ── helpers base64 ────────────────────────────────────────────────────────────
function b64(buf) {
  if (buf == null) return undefined;
  // Já em base64 (ex.: WAHA NOWEB guarda os campos do creds.json como STRING base64,
  // não como { type:'Buffer' }). Re-encodar a string trataria os chars como bytes crus
  // (64 bytes viram 88) → erro "esperado 64, veio 88". Passa a string direto.
  if (typeof buf === 'string') return buf;
  if (Buffer.isBuffer(buf)) return buf.toString('base64');
  return Buffer.from(buf).toString('base64');
}
function b64ToBuf(s) {
  if (s == null || s === '') return null;
  return Buffer.from(String(s), 'base64');
}
function isAllZero(buf) {
  return Buffer.isBuffer(buf) && buf.every((x) => x === 0);
}

// ── X25519: derivar pública (32B) a partir da privada (32B) ───────────────────
// Prefixo PKCS8 DER de uma X25519 private key (OID 1.3.101.110):
//   30 2e 02 01 00 30 05 06 03 2b 65 6e 04 22 04 20 || <32 bytes priv>
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function x25519PublicFromPrivate(priv32) {
  const p = Buffer.isBuffer(priv32) ? priv32 : Buffer.from(priv32);
  if (p.length !== 32) throw new CredsError('CREDS_INVALID', `private key esperava 32 bytes, veio ${p.length}`);
  const der = Buffer.concat([X25519_PKCS8_PREFIX, p]);
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(priv);
  const spki = pub.export({ type: 'spki', format: 'der' });
  return spki.subarray(-32); // últimos 32 bytes do SPKI = pública crua (u-coordinate Montgomery)
}

// par x25519 novo (só p/ preencher shape do skeleton Baileys; não é lido no login)
function genCurveKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return { private: priv, public: pub };
}

// ── erros ─────────────────────────────────────────────────────────────────────
class CredsError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

// base64 -> 32 bytes. Aceita 32 crus OU 33 com prefixo libsignal 0x05.
function key32(s, name) {
  const b = b64ToBuf(s) || Buffer.alloc(0);
  if (b.length === 32) return b;
  if (b.length === 33 && b[0] === 0x05) return b.subarray(1);
  throw new CredsError('CREDS_INVALID', `${name}: esperado 32/33 bytes, veio ${b.length}`);
}
function sig64(s, name) {
  const b = b64ToBuf(s) || Buffer.alloc(0);
  if (b.length !== 64) throw new CredsError('CREDS_INVALID', `${name}: esperado 64 bytes, veio ${b.length}`);
  return b;
}

// JID -> formato whatsmeow "user:device@server" (device 0 omitido; sufixo agent ".N" removido).
function normalizeJid(id, name) {
  const v = String(id || '').trim();
  const at = v.indexOf('@');
  if (at <= 0) throw new CredsError('CREDS_INVALID', `${name}: JID inválido "${v}"`);
  let local = v.slice(0, at);
  const server = v.slice(at + 1);
  local = local.replace(/\.\d+(?=:|$)/, '');
  if (local.endsWith(':0')) local = local.slice(0, -2);
  if (!local) throw new CredsError('CREDS_INVALID', `${name}: JID inválido "${v}"`);
  return `${local}@${server}`;
}

// ── Contrato A: validação de campos mínimos ───────────────────────────────────
function passportMissing(dump) {
  const missing = [];
  if (!dump || typeof dump !== 'object') return ['passport'];
  if (!dump.noiseKey || !dump.noiseKey.private) missing.push('noiseKey');
  if (!dump.signedIdentityKey || !dump.signedIdentityKey.private) missing.push('identityKey');
  if (!dump.signedPreKey || !dump.signedPreKey.keyPair || !dump.signedPreKey.keyPair.private || !dump.signedPreKey.signature) {
    missing.push('signedPreKey');
  }
  if (dump.registrationId == null) missing.push('registrationId');
  if (!dump.me || !dump.me.id) missing.push('me.id');
  if (!dump.account || !dump.account.details || !dump.account.accountSignature || !dump.account.deviceSignature) {
    missing.push('account');
  }
  return missing;
}

// Garante que as 3 públicas estejam presentes (deriva da privada se faltar).
// OBRIGATÓRIO antes de qualquer import NATIVO (WuzAPI/UAZAPI exigem as públicas).
function ensurePublics(dump) {
  const out = JSON.parse(JSON.stringify(dump || {}));
  const fill = (kp, name) => {
    if (!kp || !kp.private) return kp;
    if (kp.public) return kp;
    const priv = key32(kp.private, name);
    kp.public = b64(x25519PublicFromPrivate(priv));
    return kp;
  };
  if (out.noiseKey) fill(out.noiseKey, 'noiseKey.private');
  if (out.signedIdentityKey) fill(out.signedIdentityKey, 'signedIdentityKey.private');
  if (out.signedPreKey && out.signedPreKey.keyPair) fill(out.signedPreKey.keyPair, 'signedPreKey.keyPair.private');
  return out;
}

// ── Baileys: Contrato A -> AuthenticationCreds (skeleton + overlay) ────────────
function initAuthCredsSkeleton() {
  return {
    noiseKey: genCurveKeyPair(),
    pairingEphemeralKeyPair: genCurveKeyPair(),
    signedIdentityKey: genCurveKeyPair(),
    signedPreKey: undefined,
    registrationId: 0,
    advSecretKey: crypto.randomBytes(32).toString('base64'),
    processedHistoryMessages: [],
    nextPreKeyId: 1,
    firstUnuploadedPreKeyId: 1,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },
    registered: false,
    pairingCode: undefined,
    lastPropHash: undefined,
    routingInfo: undefined,
    additionalData: undefined,
  };
}

function dumpKeyPair(o) {
  return o ? { private: b64ToBuf(o.private), public: b64ToBuf(o.public) } : undefined;
}

// Contrato A (base64) -> objeto Baileys (Buffers).
function buildBaileysCredsFromWebDump(dump) {
  const creds = initAuthCredsSkeleton();
  if (dump.noiseKey) creds.noiseKey = dumpKeyPair(dump.noiseKey);
  if (dump.signedIdentityKey) creds.signedIdentityKey = dumpKeyPair(dump.signedIdentityKey);
  if (dump.signedPreKey) {
    creds.signedPreKey = {
      keyId: dump.signedPreKey.keyId,
      keyPair: dumpKeyPair(dump.signedPreKey.keyPair),
      signature: b64ToBuf(dump.signedPreKey.signature),
    };
  }
  if (dump.registrationId != null) creds.registrationId = dump.registrationId;
  if (dump.advSecretKey) creds.advSecretKey = dump.advSecretKey; // STRING (não Buffer)
  if (dump.me) creds.me = { id: dump.me.id, lid: dump.me.lid || undefined, name: dump.me.name || undefined };
  if (dump.account) {
    creds.account = {
      details: b64ToBuf(dump.account.details),
      accountSignatureKey: b64ToBuf(dump.account.accountSignatureKey),
      accountSignature: b64ToBuf(dump.account.accountSignature),
      deviceSignature: b64ToBuf(dump.account.deviceSignature),
    };
  }
  if (dump.nextPreKeyId != null) creds.nextPreKeyId = dump.nextPreKeyId;
  if (dump.firstUnuploadedPreKeyId != null) creds.firstUnuploadedPreKeyId = dump.firstUnuploadedPreKeyId;
  creds.platform = dump.platform || 'web';
  creds.registered = true; // device existente -> login, não pareamento
  return creds;
}

// BufferJSON.replacer do Baileys (EXATO). Buffer -> { type:'Buffer', data: base64 }.
function bufferJsonReplacer(_key, value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || (value && value.type === 'Buffer')) {
    return { type: 'Buffer', data: Buffer.from(value.data || value).toString('base64') };
  }
  return value;
}

// BufferJSON.reviver (aceita data como base64 [evolution] ou array [outras versões]).
function bufferJsonReviver(_key, value) {
  if (value && value.type === 'Buffer') {
    if (typeof value.data === 'string') return Buffer.from(value.data, 'base64');
    if (Array.isArray(value.data)) return Buffer.from(value.data);
  }
  return value;
}

// Contrato A -> string credsEncoded (BufferJSON, 1x). O adapter do Evolution embrulha 2x.
function buildEvoCredsEncoded(dump) {
  return JSON.stringify(buildBaileysCredsFromWebDump(dump), bufferJsonReplacer);
}

// Coluna Session.creds (duplo-encode) -> objeto Baileys (Buffers).
function parseEvolutionCredsColumn(col) {
  if (col == null || col === '') throw new CredsError('CREDS_INVALID', 'Session.creds vazio');
  let inner = col;
  // duplo-encode: JSON.stringify(JSON.stringify(creds, replacer)). 1º parse desfaz o embrulho externo.
  try {
    const once = JSON.parse(col);
    inner = typeof once === 'string' ? once : col; // se já veio 1x, once é objeto -> reusa col cru abaixo
    if (typeof once !== 'string') {
      return JSON.parse(JSON.stringify(once), bufferJsonReviver);
    }
  } catch (_e) {
    inner = col;
  }
  return JSON.parse(inner, bufferJsonReviver);
}

// ── whatsmeow: Contrato A -> linha whatsmeow_device (para gravação via SQL) ────
function buildDeviceRow(creds) {
  if (!creds || typeof creds !== 'object') throw new CredsError('CREDS_INVALID', 'creds ausente ou não-objeto');
  const { noiseKey, signedIdentityKey, signedPreKey, account, me } = creds;
  if (!noiseKey || !noiseKey.private || !signedIdentityKey || !signedIdentityKey.private) {
    throw new CredsError('CREDS_INVALID', 'noiseKey.private/signedIdentityKey.private obrigatórios');
  }
  if (!signedPreKey || !signedPreKey.keyPair || !signedPreKey.keyPair.private || !signedPreKey.signature) {
    throw new CredsError('CREDS_INVALID', 'signedPreKey incompleto');
  }
  if (typeof creds.registrationId !== 'number') throw new CredsError('CREDS_INVALID', 'registrationId ausente');
  if (!me || !me.id) throw new CredsError('CREDS_INVALID', 'me.id ausente');
  if (!account || !account.details || !account.accountSignature || !account.accountSignatureKey || !account.deviceSignature) {
    throw new CredsError('CREDS_MISSING_ACCOUNT', 'creds.account (ADV) obrigatório p/ whatsmeow');
  }
  let advKey = b64ToBuf(creds.advSecretKey) || Buffer.alloc(0);
  if (advKey.length === 0) advKey = Buffer.alloc(32);

  return {
    jid: normalizeJid(me.id, 'me.id'),
    lid: me.lid ? normalizeJid(me.lid, 'me.lid') : null,
    registrationId: creds.registrationId >>> 0,
    noiseKey: key32(noiseKey.private, 'noiseKey.private'),
    identityKey: key32(signedIdentityKey.private, 'signedIdentityKey.private'),
    signedPreKey: key32(signedPreKey.keyPair.private, 'signedPreKey.keyPair.private'),
    signedPreKeyId: Number(signedPreKey.keyId) || 0,
    signedPreKeySig: sig64(signedPreKey.signature, 'signedPreKey.signature'),
    advKey,
    advDetails: b64ToBuf(account.details) || Buffer.alloc(0),
    advAccountSig: sig64(account.accountSignature, 'account.accountSignature'),
    advAccountSigKey: key32(account.accountSignatureKey, 'account.accountSignatureKey'),
    advDeviceSig: sig64(account.deviceSignature, 'account.deviceSignature'),
    platform: String(creds.platform || ''),
    pushName: String((me && me.name) || ''),
  };
}

// ── EXPORTADORES: store -> Contrato A ─────────────────────────────────────────

// whatsmeow_device (linha do banco, Buffers) -> Contrato A (deriva as 3 públicas).
// row = { jid, lid, registration_id, noise_key, identity_key, signed_pre_key,
//         signed_pre_key_id, signed_pre_key_sig, adv_key, adv_details,
//         adv_account_sig, adv_account_sig_key, adv_device_sig, platform, push_name }
function whatsmeowRowToPassport(row) {
  const kp = (privBuf, name) => {
    const priv = Buffer.isBuffer(privBuf) ? privBuf : Buffer.from(privBuf);
    const p = priv.length === 33 && priv[0] === 0x05 ? priv.subarray(1) : priv;
    return { private: b64(p), public: b64(x25519PublicFromPrivate(p)) };
  };
  const advKey = Buffer.isBuffer(row.adv_key) ? row.adv_key : Buffer.from(row.adv_key || []);
  return {
    noiseKey: kp(row.noise_key, 'noise_key'),
    signedIdentityKey: kp(row.identity_key, 'identity_key'),
    signedPreKey: {
      keyId: Number(row.signed_pre_key_id) || 0,
      keyPair: kp(row.signed_pre_key, 'signed_pre_key'),
      signature: b64(row.signed_pre_key_sig),
    },
    registrationId: Number(row.registration_id) >>> 0,
    advSecretKey: isAllZero(advKey) ? null : b64(advKey),
    account: {
      details: b64(row.adv_details),
      accountSignatureKey: b64(row.adv_account_sig_key),
      accountSignature: b64(row.adv_account_sig),
      deviceSignature: b64(row.adv_device_sig),
    },
    me: { id: row.jid, lid: row.lid || undefined, name: row.push_name || undefined },
    platform: row.platform || 'web',
  };
}

// Objeto Baileys (Buffers, já revivido) -> Contrato A. Baileys guarda o par completo.
function baileysCredsToPassport(creds) {
  const kp = (o) => (o ? { private: b64(o.private), public: b64(o.public) } : undefined);
  const out = {
    noiseKey: kp(creds.noiseKey),
    signedIdentityKey: kp(creds.signedIdentityKey),
    signedPreKey: creds.signedPreKey
      ? { keyId: creds.signedPreKey.keyId, keyPair: kp(creds.signedPreKey.keyPair), signature: b64(creds.signedPreKey.signature) }
      : undefined,
    registrationId: creds.registrationId,
    advSecretKey: typeof creds.advSecretKey === 'string' ? creds.advSecretKey : b64(creds.advSecretKey),
    account: creds.account
      ? {
          details: b64(creds.account.details),
          accountSignatureKey: b64(creds.account.accountSignatureKey),
          accountSignature: b64(creds.account.accountSignature),
          deviceSignature: b64(creds.account.deviceSignature),
        }
      : null,
    me: creds.me ? { id: creds.me.id, lid: creds.me.lid, name: creds.me.name } : undefined,
    platform: creds.platform || 'web',
  };
  return ensurePublics(out);
}

// Desembrulha o body do import: aceita { creds:<dump> } ou o export completo da extensão.
function unwrapDump(body) {
  const b = body || {};
  let d = b.creds != null ? b.creds : b.passport != null ? b.passport : b;
  if (d && typeof d === 'object' && d.creds && typeof d.creds === 'object' && (d.creds.noiseKey || d.creds.me || d.creds.account)) {
    d = d.creds;
  }
  return d;
}

module.exports = {
  CredsError,
  b64,
  b64ToBuf,
  key32,
  sig64,
  normalizeJid,
  x25519PublicFromPrivate,
  passportMissing,
  ensurePublics,
  buildBaileysCredsFromWebDump,
  bufferJsonReplacer,
  bufferJsonReviver,
  buildEvoCredsEncoded,
  parseEvolutionCredsColumn,
  buildDeviceRow,
  whatsmeowRowToPassport,
  baileysCredsToPassport,
  unwrapDump,
};
