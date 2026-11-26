const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const VAULT_KEY_PATH = path.join(DATA_DIR, '.vault.key');
const SESSION_COOKIE_NAME = 'bcol_auth_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

// Parámetros criptográficos de alto costo contra fuerza bruta (scrypt)
const SCRYPT_PARAMS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};

/**
 * CREDENCIALES DEL SISTEMA (SOLO MODIFICABLES POR CÓDIGO)
 * Ni el usuario ni la contraseña existen en texto plano en ningún archivo.
 * Ambos están almacenados únicamente como derivaciones irreversibles scrypt de 512 bits con sal de 256 bits.
 *
 * Para generar nuevas credenciales por consola sin exponer la clave en el código:
 *   node src/security.js generar-credenciales "NUEVO_USUARIO" "NuevaClaveSegura"
 */
const DEFAULT_ADMIN_AUTH = Object.freeze({
  uSalt: '004a05513d6dc10aadca7bcd007d2a94b7fa4fa7eb678f3871e41daa26b0585c',
  uHash: '5bed2e925a74f316407d36825ba3c6d35e39769558ab71af0b41704dedaf0439b85ea5dfcd3e86aa7a047dfb0f017bc559879918043fab28f1e6d0a89957f2f2',
  pSalt: '32bdb93a154cd10e3c5eb04c922168b52d6f295692ae95524f5a024afc7b98d8',
  pHash: '44fe1a6e096c83a196e1eb55b43450b49c182ae8b1607ef4eff055d230d71a19d03ece66047e0bb1ea01ed8b91de1b4dff1513642bd6936783460cfa48c9ff5a'
});

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

  // En entornos efímeros de nube (Render) sin APP_SECRET_KEY explícita, derivar llave estable
  // para que las sesiones y bóvedas cifradas sobrevivan cuando el contenedor entra en reposo
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

function generateCredentialsConfig(username, password) {
  const uSalt = crypto.randomBytes(32);
  const pSalt = crypto.randomBytes(32);
  const uHash = crypto.scryptSync(String(username).trim(), uSalt, 64, SCRYPT_PARAMS);
  const pHash = crypto.scryptSync(String(password), pSalt, 64, SCRYPT_PARAMS);
  return {
    uSalt: uSalt.toString('hex'),
    uHash: uHash.toString('hex'),
    pSalt: pSalt.toString('hex'),
    pHash: pHash.toString('hex')
  };
}

function verifyAdminCredentials(username, password, authConfig = DEFAULT_ADMIN_AUTH) {
  const cleanUser = String(username || '').trim();
  const rawPass = String(password || '');

  const uSalt = Buffer.from(authConfig.uSalt, 'hex');
  const expectedUHash = Buffer.from(authConfig.uHash, 'hex');
  const pSalt = Buffer.from(authConfig.pSalt, 'hex');
  const expectedPHash = Buffer.from(authConfig.pHash, 'hex');

  // Ejecutar siempre ambos cálculos scrypt para impedir ataques de tiempo (timing attacks)
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

  return userOk && passOk;
}

// --- CIFRADO AUTENTICADO AES-256-GCM PARA LA CLAVE DE APLICACIÓN ---
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

// --- GESTIÓN DE SESIONES FIRMADAS (HMAC-SHA256) Y REVOCACIÓN ---
const revokedJtis = new Map();

function cleanupRevoked() {
  const now = Date.now();
  for (const [jti, exp] of revokedJtis.entries()) {
    if (exp <= now) revokedJtis.delete(jti);
  }
}

function createSessionToken(ttlMs = SESSION_TTL_MS) {
  const now = Date.now();
  const payload = {
    role: 'admin',
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
    if (!payload || payload.role !== 'admin' || !payload.exp || Date.now() > payload.exp) {
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

// --- PROTECCIÓN CONTRA FUERZA BRUTA POR IP ---
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

// Utilidad de línea de comandos para cambiar usuario/clave por código sin dejar texto plano
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'generar-credenciales') {
    const newUser = process.argv[3];
    const newPass = process.argv[4];
    if (!newUser || !newPass) {
      console.error('Uso: node src/security.js generar-credenciales "NUEVO_USUARIO" "NuevaClave"');
      process.exit(1);
    }
    const generated = generateCredentialsConfig(newUser, newPass);
    console.log('\nReemplaza DEFAULT_ADMIN_AUTH en src/security.js con este bloque:\n');
    console.log('const DEFAULT_ADMIN_AUTH = Object.freeze(' + JSON.stringify(generated, null, 2) + ');\n');
    process.exit(0);
  }

  if (cmd === 'cifrar-clave-correo') {
    const appPass = process.argv[3];
    if (!appPass) {
      console.error('Uso: node src/security.js cifrar-clave-correo "tu_clave_de_aplicacion"');
      process.exit(1);
    }
    console.log('\nClave de aplicación cifrada (AES-256-GCM):\n');
    console.log(encryptSecret(appPass) + '\n');
    process.exit(0);
  }
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  DEFAULT_ADMIN_AUTH,
  generateCredentialsConfig,
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
