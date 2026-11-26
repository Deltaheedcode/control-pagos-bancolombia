const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const VAULT_KEY_PATH = path.join(DATA_DIR, '.vault.key');
const SESSION_COOKIE_NAME = 'bcol_auth_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días de sesión continua

// Parámetros criptográficos de alto costo contra fuerza bruta (scrypt)
const SCRYPT_PARAMS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};

/**
 * CUENTAS VERIFICABLES DEL SISTEMA (SOLO MODIFICABLES POR CÓDIGO)
 * Ningún usuario ni contraseña existe en texto plano en ningún archivo.
 * Todos están almacenados únicamente como derivaciones irreversibles scrypt de 512 bits con sal de 256 bits.
 *
 * Roles:
 *  - 'admin': Control total (configuración, simulador, borrado, QR, PDF, pagos)
 *  - 'viewer': Solo lectura para celulares (ver pagos en tiempo real y lectura de voz)
 *
 * Para generar nuevas credenciales por consola sin exponer claves en el código:
 *   node src/security.js generar-credenciales "viewer" "Celular 1" "NUEVO_USUARIO" "NuevaClave"
 */
const DEFAULT_ACCOUNTS = Object.freeze([
  Object.freeze({
    id: 'admin',
    role: 'admin',
    label: 'Administrador',
    uSalt: '004a05513d6dc10aadca7bcd007d2a94b7fa4fa7eb678f3871e41daa26b0585c',
    uHash: '5bed2e925a74f316407d36825ba3c6d35e39769558ab71af0b41704dedaf0439b85ea5dfcd3e86aa7a047dfb0f017bc559879918043fab28f1e6d0a89957f2f2',
    pSalt: '32bdb93a154cd10e3c5eb04c922168b52d6f295692ae95524f5a024afc7b98d8',
    pHash: '44fe1a6e096c83a196e1eb55b43450b49c182ae8b1607ef4eff055d230d71a19d03ece66047e0bb1ea01ed8b91de1b4dff1513642bd6936783460cfa48c9ff5a'
  }),
  Object.freeze({
    id: 'phone_1',
    role: 'viewer',
    label: 'Celular 1',
    uSalt: '21569d32e55939a74cf52ce9c95cddf0d3378b2bf52f8f4d3824a5780733ac27',
    uHash: '52d5829bda658608dec7195f65755e99c9e63bab8fe115e7578718657c9cdaf6db89c2e75162f5581d307ef6acd992b45191a77ab2f33783fd63903f4599cf14',
    pSalt: '6bdecda1dd1b3303fc98d33f31bd603ea35a6e4fc5b70c3b4d02aea2705ccd12',
    pHash: '89fde2ff2f50dc1ec28f676882acd56c25334cf94a985fbfe62ead2ca5cc5dfd8e329061c7ce0f7b7e2ba378048e5a8611ca3697db7d01d80f7bd38de125b00b'
  }),
  Object.freeze({
    id: 'phone_2',
    role: 'viewer',
    label: 'Celular 2',
    uSalt: '87871faa1302f2289b44e4efbb570bbe08ee624201640148af9cf8e64bc59420',
    uHash: '7357e998bce854800744237b9a34173f55727d638b449094d2ebb298c5174d5a9757f7fc5185a61ae13df60aae45780bb0de4e18a0cec22f63ff3209be8690a1',
    pSalt: 'd790ef998ff8988c559f7d70759da15b387340865af05b251a98fa959639586c',
    pHash: '69f14d55da16a304f43200682018a46249956cadf044f88c3ccb1551182dc581224d0ca472ff325698fc561d855a2a73a553bfbab2c0d8ee01999f99e7fdd89a'
  })
]);

const DEFAULT_ADMIN_AUTH = DEFAULT_ACCOUNTS[0];

// Fragmentos ofuscados por XOR en memoria para reforzar la derivación de bóveda AES-256-GCM
const SHARD_A = [
  0x9a, 0x41, 0xd7, 0x2c, 0x88, 0xf3, 0x19, 0x6e,
  0x54, 0xb2, 0x0d, 0x77, 0xe1, 0x3a, 0xc9, 0x62,
  0x4f, 0x90, 0xab, 0x15, 0xfe, 0x28, 0x73, 0xd4,
  0x31, 0x8c, 0x5b, 0xe9, 0x04, 0x6a, 0xbd, 0x97
];
const SHARD_B = [
  0x3f, 0x18, 0xa2, 0x79, 0xe4, 0x91, 0x4c, 0x05,
  0x2d, 0xd8, 0x6b, 0x13, 0x89, 0x57, 0xfa, 0x0e,
  0x22, 0xf5, 0xc7, 0x60, 0x93, 0x41, 0x1e, 0xb9,
  0x58, 0xe2, 0x30, 0x84, 0x71, 0x0f, 0xd2, 0xfc
];

function assembleInternalPepper() {
  const buf = Buffer.alloc(SHARD_A.length);
  for (let i = 0; i < SHARD_A.length; i += 1) {
    buf[i] = (SHARD_A[i] ^ SHARD_B[i] ^ ((i * 17 + 0x5a) & 0xff)) & 0xff;
  }
  return buf;
}

function getOrCreateRuntimeMasterSecret() {
  if (process.env.APP_SECRET_KEY && process.env.APP_SECRET_KEY.trim().length >= 32) {
    return Buffer.from(process.env.APP_SECRET_KEY.trim(), 'utf8');
  }

  // En Render se mantiene exactamente la misma derivación estable para no invalidar bóvedas previas
  if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
    return crypto
      .createHash('sha256')
      .update(DEFAULT_ADMIN_AUTH.pHash + ':' + DEFAULT_ADMIN_AUTH.uHash + ':render-stable-v1')
      .digest();
  }

  try {
    if (fs.existsSync(VAULT_KEY_PATH)) {
      const raw = fs.readFileSync(VAULT_KEY_PATH, 'utf8').trim();
      if (raw.length >= 64) {
        return Buffer.from(raw, 'hex');
      }
    }
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(VAULT_KEY_PATH, generated.toString('hex'), { mode: 0o600 });
    return generated;
  } catch (_) {
    return crypto.createHash('sha256').update(process.cwd() + '__runtime_vault').digest();
  }
}

let cachedVaultKey = null;
let cachedSessionKey = null;

function getVaultAesKey() {
  if (cachedVaultKey) return cachedVaultKey;
  const master = getOrCreateRuntimeMasterSecret();
  const pepper = assembleInternalPepper();
  cachedVaultKey = crypto.scryptSync(master, pepper, 32, { N: 16384, r: 8, p: 1 });
  pepper.fill(0);
  return cachedVaultKey;
}

function getSessionSigningKey() {
  if (cachedSessionKey) return cachedSessionKey;
  const master = getOrCreateRuntimeMasterSecret();
  cachedSessionKey = crypto
    .createHmac('sha256', master)
    .update('bcol-session-hmac-v1')
    .digest();
  return cachedSessionKey;
}

function generateCredentialsConfig(username, password, role = 'admin', label = 'Usuario') {
  const uSalt = crypto.randomBytes(32);
  const pSalt = crypto.randomBytes(32);
  const uHash = crypto.scryptSync(String(username).trim(), uSalt, 64, SCRYPT_PARAMS);
  const pHash = crypto.scryptSync(String(password), pSalt, 64, SCRYPT_PARAMS);
  return {
    id: `${role}_${crypto.randomBytes(3).toString('hex')}`,
    role: role === 'viewer' ? 'viewer' : 'admin',
    label: String(label || (role === 'viewer' ? 'Celular' : 'Administrador')),
    uSalt: uSalt.toString('hex'),
    uHash: uHash.toString('hex'),
    pSalt: pSalt.toString('hex'),
    pHash: pHash.toString('hex')
  };
}

function verifyAccountCredentials(username, password, accountsOrSingle = DEFAULT_ACCOUNTS) {
  const cleanUser = String(username || '').trim();
  const rawPass = String(password || '');
  const list = Array.isArray(accountsOrSingle)
    ? accountsOrSingle
    : [{ ...accountsOrSingle, id: 'admin', role: 'admin', label: 'Administrador' }];

  let matchedAccount = null;

  // Evaluar todas las cuentas sin retorno temprano para mantener tiempo constante
  for (const acc of list) {
    const uSalt = Buffer.from(acc.uSalt, 'hex');
    const expectedUHash = Buffer.from(acc.uHash, 'hex');
    const pSalt = Buffer.from(acc.pSalt, 'hex');
    const expectedPHash = Buffer.from(acc.pHash, 'hex');

    const actualUHash = crypto.scryptSync(cleanUser, uSalt, 64, SCRYPT_PARAMS);
    const actualPHash = crypto.scryptSync(rawPass, pSalt, 64, SCRYPT_PARAMS);

    const userOk =
      actualUHash.length === expectedUHash.length &&
      crypto.timingSafeEqual(actualUHash, expectedUHash);
    const passOk =
      actualPHash.length === expectedPHash.length &&
      crypto.timingSafeEqual(actualPHash, expectedPHash);

    actualUHash.fill(0);
    actualPHash.fill(0);

    if (userOk && passOk && !matchedAccount) {
      matchedAccount = {
        accountId: acc.id || 'user',
        role: acc.role === 'viewer' ? 'viewer' : 'admin',
        label: acc.label || (acc.role === 'viewer' ? 'Celular' : 'Administrador')
      };
    }
  }

  if (!matchedAccount) {
    return { valid: false };
  }

  return {
    valid: true,
    ...matchedAccount
  };
}

function verifyAdminCredentials(username, password, authConfig = DEFAULT_ACCOUNTS) {
  const res = verifyAccountCredentials(username, password, authConfig);
  return res.valid && res.role === 'admin';
}

// --- CIFRADO AUTENTICADO AES-256-GCM ---
const ENC_PREFIX = 'enc:gcm:v1:';

function isEncryptedSecret(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

function encryptSecret(plainText) {
  if (!plainText) return '';
  if (isEncryptedSecret(plainText)) return plainText;

  const key = getVaultAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return (
    ENC_PREFIX +
    iv.toString('base64url') +
    ':' +
    authTag.toString('base64url') +
    ':' +
    encrypted.toString('base64url')
  );
}

function decryptSecret(storedValue) {
  if (!storedValue) return '';
  if (!isEncryptedSecret(storedValue)) {
    return String(storedValue);
  }

  try {
    const body = storedValue.slice(ENC_PREFIX.length);
    const [ivB64, tagB64, dataB64] = body.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return '';

    const key = getVaultAesKey();
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(tagB64, 'base64url');
    const ciphertext = Buffer.from(dataB64, 'base64url');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch (_) {
    return '';
  }
}

// --- SESIONES FIRMADAS HMAC-SHA256 CON ROL ---
const revokedJtis = new Map();

function cleanupRevoked() {
  const now = Date.now();
  for (const [jti, exp] of revokedJtis.entries()) {
    if (exp <= now) revokedJtis.delete(jti);
  }
}

function createSessionToken(accountInfo = {}, ttlMs = SESSION_TTL_MS) {
  const now = Date.now();
  const role = accountInfo.role === 'viewer' ? 'viewer' : 'admin';
  const payload = {
    role,
    accountId: accountInfo.accountId || role,
    label: accountInfo.label || (role === 'viewer' ? 'Celular' : 'Administrador'),
    jti: crypto.randomBytes(16).toString('hex'),
    iat: now,
    exp: now + ttlMs
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSigningKey())
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSigningKey())
    .update(payloadB64)
    .digest();

  let providedSig;
  try {
    providedSig = Buffer.from(sigB64, 'base64url');
  } catch (_) {
    return null;
  }

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(providedSig, expectedSig)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (
      !payload ||
      (payload.role !== 'admin' && payload.role !== 'viewer') ||
      !payload.exp ||
      Date.now() > payload.exp
    ) {
      return null;
    }
    if (payload.jti && revokedJtis.has(payload.jti)) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function revokeSessionToken(token) {
  const payload = verifySessionToken(token);
  if (payload && payload.jti) {
    cleanupRevoked();
    revokedJtis.set(payload.jti, payload.exp);
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const pairs = String(cookieHeader).split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch (_) {
        out[k] = v;
      }
    }
  }
  return out;
}

class LoginRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  check(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry) return { blocked: false, remaining: this.maxAttempts };

    if (now > entry.resetAt) {
      this.attempts.delete(key);
      return { blocked: false, remaining: this.maxAttempts };
    }

    if (entry.count >= this.maxAttempts) {
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      };
    }

    return { blocked: false, remaining: this.maxAttempts - entry.count };
  }

  recordFailure(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now > entry.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  reset(ip) {
    this.attempts.delete(String(ip || 'unknown'));
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'generar-credenciales') {
    // Soporta tanto 2 args ("USUARIO" "CLAVE") como 4 args ("viewer" "Celular 1" "USUARIO" "CLAVE")
    if (process.argv.length >= 7) {
      const [, , , role, label, newUser, newPass] = process.argv;
      const generated = generateCredentialsConfig(newUser, newPass, role, label);
      console.log('\nAgrega o reemplaza este bloque en DEFAULT_ACCOUNTS de src/security.js:\n');
      console.log('Object.freeze(' + JSON.stringify(generated, null, 2) + ')\n');
      process.exit(0);
    } else if (process.argv.length >= 5) {
      const newUser = process.argv[3];
      const newPass = process.argv[4];
      const generated = generateCredentialsConfig(newUser, newPass, 'admin', 'Administrador');
      console.log('\nBloque generado para src/security.js:\n');
      console.log('Object.freeze(' + JSON.stringify(generated, null, 2) + ')\n');
      process.exit(0);
    }
    console.error('Uso: node src/security.js generar-credenciales "admin|viewer" "Etiqueta" "USUARIO" "Clave"');
    process.exit(1);
  }
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  DEFAULT_ACCOUNTS,
  DEFAULT_ADMIN_AUTH,
  generateCredentialsConfig,
  verifyAccountCredentials,
  verifyAdminCredentials,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret,
  createSessionToken,
  verifySessionToken,
  revokeSessionToken,
  parseCookies,
  LoginRateLimiter
};
