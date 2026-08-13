'use strict';

const crypto = require('crypto');

// Comparação de segredo em tempo constante (guarda de tamanho vaza só o comprimento).
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (_e) {
    return false;
  }
}

// Middleware Express: exige header x-hub-secret == HUB_SECRET.
function requireSecret(secret) {
  return function (req, res, next) {
    const provided = req.get('x-hub-secret') || '';
    if (!secret || !timingSafeEqualStr(provided, secret)) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    return next();
  };
}

// Bloqueia toda operacao que possa criar QR, conectar, enviar, importar,
// desconectar, excluir ou migrar enquanto a instalacao estiver em modo seguro.
function requireMutationsEnabled(enabled) {
  return function (_req, res, next) {
    if (!enabled) {
      return res.status(503).json({ error: 'MUTATIONS_DISABLED' });
    }
    return next();
  };
}

// HTTP JSON com timeout (fetch nativo, Node >= 18). Devolve { ok, status, data }.
// headers extras permitem esquemas de auth diferentes de `apikey` (ex.: token, X-Api-Key).
async function httpJson(method, url, { apikey, headers, body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(apikey ? { apikey } : {}),
        ...(headers || {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_e) {
        data = text;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

// jid/número -> só dígitos (base do DEDUP por número). "5511999999999:12@s.whatsapp.net" -> "5511999999999"
function jidToNumber(jid) {
  if (!jid) return '';
  const s = String(jid);
  const at = s.indexOf('@');
  const local = at > 0 ? s.slice(0, at) : s;
  const user = local.split(':')[0].split('.')[0];
  return (user.match(/\d+/g) || []).join('');
}

class NotSupportedError extends Error {
  constructor(msg) {
    super(msg || 'NOT_SUPPORTED');
    this.code = 'NOT_SUPPORTED';
  }
}

// Poll: chama fn() até pred(valor) === true ou estourar o timeout. Devolve o último valor (ou null).
async function pollUntil(fn, pred, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
    } catch (_e) {
      last = null;
    }
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

function log(...args) {
  console.log('[hub]', ...args);
}
function errlog(...args) {
  console.error('[hub]', ...args);
}

// hash curto p/ auditoria sem vazar conteúdo.
function shortHash(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''));
  return b.length ? crypto.createHash('sha256').update(b).digest('hex').slice(0, 12) : '-';
}

// Gera um QR PNG PRETO (data-URI) a partir do conteúdo (string) do QR. Padroniza a cor
// entre APIs (ex.: o Evolution devolve uma imagem azulada/sem contraste). Lazy require:
// se a lib `qrcode` não estiver instalada, devolve null e o caller usa o fallback.
let _qrcode = null;
function loadQrcode() {
  if (_qrcode === null) {
    try {
      _qrcode = require('qrcode');
    } catch (_e) {
      _qrcode = false;
    }
  }
  return _qrcode;
}
async function qrPngDataUri(text) {
  if (!text) return null;
  const QR = loadQrcode();
  if (!QR) return null;
  try {
    return await QR.toDataURL(String(text), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#000000ff', light: '#ffffffff' },
    });
  } catch (_e) {
    return null;
  }
}

module.exports = {
  qrPngDataUri,
  timingSafeEqualStr,
  requireSecret,
  requireMutationsEnabled,
  httpJson,
  jidToNumber,
  NotSupportedError,
  pollUntil,
  log,
  errlog,
  shortHash,
};
