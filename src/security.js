const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const VAULT_KEY_PATH = path.join(DATA_DIR, '.vault.key');
const SESSION_COOKIE_NAME = 'bcol_strict_session_v2';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const USER_SCRYPT_PARAMS = {
  N: 1024,
  r: 8,
  p: 1
};

const PASS_SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024
};

// Semilla criptográfica fija para no invalidar bóvedas AES-256-GCM ya guardadas en Render
const RENDER_VAULT_SEED =
  '44fe1a6e096c83a196e1eb55b43450b49c182ae8b1607ef4eff055d230d71a19d03ece66047e0bb1ea01ed8b91de1b4dff1513642bd6936783460cfa48c9ff5a:' +
  '5bed2e925a74f316407d36825ba3c6d35e39769558ab71af0b41704dedaf0439b85ea5dfcd3e86aa7a047dfb0f017bc559879918043fab28f1e6d0a89957f2f2:' +
  'render-stable-v1';

/**
 * Normaliza el nombre de usuario (ignora mayúsculas/minúsculas y espacios accidentales en móvil,
 * por ejemplo "celular 1", "Celular 1", "celular1" y "CELULAR1" se normalizan igual antes de derivar su hash).
 */
function normalizeUsernameInput(username) {
  return String(username || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * CUENTAS VERIFICABLES DEL SISTEMA (SOLO MODIFICABLES POR CÓDIGO)
 * Cero usuarios o claves en texto plano.
 */
const DEFAULT_ACCOUNTS = Object.freeze([
  Object.freeze({
    id: 'admin',
    role: 'admin',
    label: 'Administrador',
    uSalt: 'a7e9934823928e0a27094b12b80ee27ab147fd2b23f8b682bc10b5dc46b07b93',
    uHash: 'd3f85c7813bc353d700b4f54f3f03fb397ba31361dfcc371686a2b14f277a0a1d3e7880a266555db9aab4bdb31c768ff8246e52a2685bbe60b9555165b887b73',
    pVariants: Object.freeze([
      Object.freeze({
        pSalt: '07ef9b3f9e8a978525c6ed1251f449c5b8b18cd3b87cfad8b3287094cbe02375',
        pHash: 'b10748cceceafdb616cfcec9110692369a9c09491a7aecfb6f1038aff92bb242d1a58b76fb62a61dfa6bc32f5c7c028ec615d6dcab13e0daf4416fc9abdd30e7'
      })
    ])
  }),
  Object.freeze({
    id: 'phone_1',
    role: 'viewer',
    label: 'Celular 1',
    uSalt: 'b73a2dee042060a913556c7fcd8140ac26161994bf80c5eaef196d33322720eb',
    uHash: '1aca4317af5d7c67ca8fce815d7f7bb47be9ddd0885bcec3859dfffc5797a8498430fdded2beaf2e2b40b33115ffc43487498e8e2f198768f8790a0ba8ed6002',
    pVariants: Object.freeze([
      Object.freeze({
        pSalt: '0c934ddee2c1a06e961b28a45e086e4afc3da14bc86d5af6d1f0c4597b077351',
        pHash: '444cf0af1ec3b8351c34b39f8386d69dac5b809b2f409b0598494ca80ed95ea9cd0e93b9c3c4ad98f6e7e7e30648da5eb9d1445503d6eead0d658350cf952df1'
      }),
      Object.freeze({
        pSalt: '9a85dbfbb6cf4320acb42741b8b5627a38cebe8660318624d310ec824fb29d8a',
        pHash: 'd4ce98ed743f1938000ee67b55c1887b480e0d6fdbb18e11e291ef1b57ec2f4dfc559e9bace326ba0ac0c4d116b9cd52de4bb3bc5940b68510a4499555ce549f'
      })
    ])
  }),
  Object.freeze({
    id: 'phone_2',
    role: 'viewer',
    label: 'Celular 2',
    uSalt: 'e03b934cc410ba84c5d7014580104bf7b14c416edd8f25f0f5e16f7ebf4c1bf8',
    uHash: 'c2e286ae347a9dbecef0b65f2b01bbeb6342223089ed8951c90ae700ec4be5ee12a62e94c32f812dad6d76af87bce127aa16b97f923b6463c9335ea890f22c77',
    pVariants: Object.freeze([
      Object.freeze({
        pSalt: 'b75513f99a836e5bab68b94d488173ede6642fc596d205fb98beb829992d49b2',
        pHash: '413843b5200164b467651ffd729d0cc21fdcb5feb2e9c3724bc9e746ee47db5f80ab2ad0a4596b4c568d6a25d34cbfc9307069127e5de3272e03489d3f612466'
      }),
      Object.freeze({
        pSalt: '219341c3b039b1eb838f83015048230380bbd10efcd50c39a0937384217a907c',
        pHash: '5832e8d38384543ac14b9915b27b7e3628669b0b81e9365f9ec4b2ff1a140c882b385b7953676a9b32cacac1927d2f3ea39f78da90c8fe035062b97f61357d10'
      })
    ])
  })
]);

const DEFAULT_ADMIN_AUTH = DEFAULT_ACCOUNTS[0];

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

  if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
    return crypto.createHash('sha256').update(RENDER_VAULT_SEED).digest();
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
  const normUser = normalizeUsernameInput(username);
  const cleanPass = String(password || '').trim();
  const uSalt = crypto.randomBytes(32);
  const pSalt = crypto.randomBytes(32);
  const uHash = crypto.scryptSync(normUser, uSalt, 64, USER_SCRYPT_PARAMS);
  const pHash = crypto.scryptSync(cleanPass, pSalt, 64, PASS_SCRYPT_PARAMS);
  return {
    id: `${role}_${crypto.randomBytes(3).toString('hex')}`,
    role: role === 'viewer' ? 'viewer' : 'admin',
    label: String(label || (role === 'viewer' ? 'Celular' : 'Administrador')),
    uSalt: uSalt.toString('hex'),
    uHash: uHash.toString('hex'),
    pVariants: [
      {
        pSalt: pSalt.toString('hex'),
        pHash: pHash.toString('hex')
      }
    ]
  };
}

function verifyAccountCredentials(username, password, accountsOrSingle = DEFAULT_ACCOUNTS) {
  const normUser = normalizeUsernameInput(username);
  // Quitar espacios exteriores accidentales al pegar claves desde el portapapeles del celular
  const cleanPass = String(password || '').trim();

  const list = Array.isArray(accountsOrSingle)
    ? accountsOrSingle
    : [{ ...accountsOrSingle, id: 'admin', role: 'admin', label: 'Administrador' }];

  // Paso 1: localizar cuenta por hash de usuario normalizado
  let targetAccount = null;
  for (const acc of list) {
    const uSalt = Buffer.from(acc.uSalt, 'hex');
    const expectedUHash = Buffer.from(acc.uHash, 'hex');
    const actualUHash = crypto.scryptSync(normUser, uSalt, 64, USER_SCRYPT_PARAMS);

    const userOk =
      actualUHash.length === expectedUHash.length &&
      crypto.timingSafeEqual(actualUHash, expectedUHash);
    actualUHash.fill(0);

    if (userOk && !targetAccount) {
      targetAccount = acc;
    }
  }

  // Si el usuario no coincide con ninguno, ejecutar un cálculo scrypt simulado para evitar ataques de tiempo
  if (!targetAccount) {
    const dummySalt = Buffer.from(list[0].uSalt, 'hex');
    const dummy = crypto.scryptSync(cleanPass, dummySalt, 64, PASS_SCRYPT_PARAMS);
    dummy.fill(0);
    return { valid: false };
  }

  // Paso 2: verificar contraseña contra las variantes autorizadas de esa cuenta
  const variants = Array.isArray(targetAccount.pVariants)
    ? targetAccount.pVariants
    : [{ pSalt: targetAccount.pSalt, pHash: targetAccount.pHash }];

  let passMatched = false;
  for (const v of variants) {
    const pSalt = Buffer.from(v.pSalt, 'hex');
    const expectedPHash = Buffer.from(v.pHash, 'hex');
    const actualPHash = crypto.scryptSync(cleanPass, pSalt, 64, PASS_SCRYPT_PARAMS);

    if (
      actualPHash.length === expectedPHash.length &&
      crypto.timingSafeEqual(actualPHash, expectedPHash)
    ) {
      passMatched = true;
    }
    actualPHash.fill(0);
  }

  if (!passMatched) {
    return { valid: false };
  }

  return {
    valid: true,
    accountId: targetAccount.id || 'user',
    role: targetAccount.role === 'viewer' ? 'viewer' : 'admin',
    label: targetAccount.label || (targetAccount.role === 'viewer' ? 'Celular' : 'Administrador')
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

// --- SESIONES ESTRICTAS DE INSTANCIA ÚNICA POR CUENTA ---
const activeSessionByAccount = new Map();
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
  const accountId = String(accountInfo.accountId || role);
  const jti = crypto.randomBytes(16).toString('hex');

  const previousJti = activeSessionByAccount.get(accountId);
  if (previousJti && previousJti !== jti) {
    cleanupRevoked();
    revokedJtis.set(previousJti, now + ttlMs);
  }
  activeSessionByAccount.set(accountId, jti);

  const payload = {
    ver: 2,
    role,
    accountId,
    label: accountInfo.label || (role === 'viewer' ? 'Celular' : 'Administrador'),
    jti,
    iat: now,
    exp: now + ttlMs
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSigningKey())
    .update(payloadB64)
    .digest('base64url');

  return { token: `${payloadB64}.${sig}`, jti, previousJti: previousJti || null, accountId };
}

function verifySessionToken(token) {
  const checked = inspectSessionToken(token);
  return checked.valid ? checked.payload : null;
}

function inspectSessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'missing' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  const [payloadB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSigningKey())
    .update(payloadB64)
    .digest();

  let providedSig;
  try {
    providedSig = Buffer.from(sigB64, 'base64url');
  } catch (_) {
    return { valid: false, reason: 'bad_sig' };
  }

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(providedSig, expectedSig)
  ) {
    return { valid: false, reason: 'bad_sig' };
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (
      !payload ||
      payload.ver !== 2 ||
      !payload.accountId ||
      (payload.role !== 'admin' && payload.role !== 'viewer') ||
      !payload.exp ||
      Date.now() > payload.exp
    ) {
      return { valid: false, reason: 'expired' };
    }
    if (payload.jti && revokedJtis.has(payload.jti)) {
      return { valid: false, reason: 'replaced' };
    }
    const currentActiveJti = activeSessionByAccount.get(payload.accountId);
    if (!currentActiveJti || currentActiveJti !== payload.jti) {
      return { valid: false, reason: 'replaced' };
    }
    return { valid: true, payload };
  } catch (_) {
    return { valid: false, reason: 'corrupt' };
  }
}

function revokeSessionToken(token) {
  const checked = inspectSessionToken(token);
  if (checked.valid && checked.payload) {
    const { jti, accountId, exp } = checked.payload;
    if (jti) {
      cleanupRevoked();
      revokedJtis.set(jti, exp);
    }
    if (accountId && activeSessionByAccount.get(accountId) === jti) {
      activeSessionByAccount.delete(accountId);
    }
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
  constructor({ maxAttempts = 8, windowMs = 10 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  check(keyStr) {
    const key = String(keyStr || 'unknown');
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

  recordFailure(keyStr) {
    const key = String(keyStr || 'unknown');
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now > entry.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  reset(keyStr) {
    this.attempts.delete(String(keyStr || 'unknown'));
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'generar-credenciales') {
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
  normalizeUsernameInput,
  generateCredentialsConfig,
  verifyAccountCredentials,
  verifyAdminCredentials,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret,
  createSessionToken,
  verifySessionToken,
  inspectSessionToken,
  revokeSessionToken,
  parseCookies,
  LoginRateLimiter
};
