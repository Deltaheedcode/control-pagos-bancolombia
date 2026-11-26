const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const NumberToSpanish = require('../public/numberToSpanish');
const security = require('./security');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'pagos_bancolombia.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL,
    sender_email TEXT NOT NULL,
    sender_name TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    amount REAL NOT NULL,
    channel TEXT DEFAULT '',
    payer TEXT DEFAULT '',
    reference TEXT DEFAULT '',
    auth_status TEXT DEFAULT 'unknown',
    auth_detail TEXT DEFAULT '',
    snippet TEXT DEFAULT '',
    is_test INTEGER DEFAULT 0,
    received_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_payments_received_at ON payments(received_at DESC);

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_email TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    reason TEXT NOT NULL,
    detail TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

const initialEnvPass = process.env.EMAIL_PASS
  ? security.encryptSecret(process.env.EMAIL_PASS)
  : '';

const DEFAULT_SETTINGS = {
  business_name: process.env.BUSINESS_NAME || 'Control de Pagos Bancolombia',
  email_provider: process.env.EMAIL_PROVIDER || 'gmail',
  email_user: process.env.EMAIL_USER || 'jhocamza@gmail.com',
  email_pass: initialEnvPass,
  imap_host: process.env.IMAP_HOST || 'imap.gmail.com',
  imap_port: process.env.IMAP_PORT || '993',
  imap_tls: process.env.IMAP_TLS || 'true',
  official_senders: process.env.OFFICIAL_SENDERS || 'jhocamza@gmail.com',
  sync_lookback: process.env.SYNC_LOOKBACK || 'today',
  voice_enabled_default: 'true'
};

const insertDefaultStmt = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  insertDefaultStmt.run(k, String(v));
}

// Migrar automáticamente cualquier clave previa sin cifrar hacia AES-256-GCM
(function migratePlaintextSecrets() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'email_pass'").get();
  if (row && row.value && !security.isEncryptedSecret(row.value)) {
    const encrypted = security.encryptSecret(row.value);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'email_pass'").run(encrypted);
  } else if ((!row || !row.value) && initialEnvPass) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'email_pass'").run(initialEnvPass);
  }
  // Eliminar antiguo PIN suelto si existía
  db.prepare("DELETE FROM settings WHERE key = 'access_pin'").run();
})();

function getAllSettings(includeSecrets = false) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const rawMap = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    rawMap[row.key] = row.value;
  }

  const decryptedPass = security.decryptSecret(rawMap.email_pass || '');

  if (!includeSecrets) {
    const safeResult = { ...rawMap };
    safeResult.has_password = Boolean(decryptedPass && decryptedPass.length > 0);
    delete safeResult.email_pass;
    return safeResult;
  }

  return {
    ...rawMap,
    email_pass: decryptedPass
  };
}

function updateSettings(partial) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const allowedKeys = Object.keys(DEFAULT_SETTINGS);
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(partial, key) && partial[key] !== undefined) {
      if (key === 'email_pass') {
        const val = String(partial.email_pass || '');
        if (val === '__KEEP__') continue;
        // Guardar siempre cifrada con AES-256-GCM en disco
        const encryptedVal = val ? security.encryptSecret(val) : '';
        upsert.run('email_pass', encryptedVal);
        continue;
      }
      upsert.run(key, String(partial[key]));
    }
  }
  return getAllSettings(false);
}

function enrichPaymentRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_test: Boolean(row.is_test),
    formatted_amount: NumberToSpanish.formatCOP(row.amount),
    voice_phrase: NumberToSpanish.paymentVoicePhrase(row.amount)
  };
}

function insertPayment(payment, isTest = false) {
  const existing = db
    .prepare('SELECT id FROM payments WHERE message_id = ?')
    .get(payment.message_id);

  if (existing) {
    return { inserted: false, payment: getPaymentById(existing.id) };
  }

  const nowIso = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO payments (
      message_id, sender_email, sender_name, subject, amount,
      channel, payer, reference, auth_status, auth_detail,
      snippet, is_test, received_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    payment.message_id,
    payment.sender_email || '',
    payment.sender_name || '',
    payment.subject || '',
    Number(payment.amount),
    payment.channel || 'Transferencia Bancolombia',
    payment.payer || '',
    payment.reference || '',
    payment.auth_status || 'unknown',
    payment.auth_detail || '',
    payment.snippet || '',
    isTest ? 1 : 0,
    payment.received_at || nowIso,
    nowIso
  );

  return {
    inserted: true,
    payment: getPaymentById(Number(info.lastInsertRowid))
  };
}

function getPaymentById(id) {
  const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  return enrichPaymentRow(row);
}

function hasMessageId(messageId) {
  if (!messageId) return false;
  const row = db.prepare('SELECT 1 FROM payments WHERE message_id = ?').get(messageId);
  return Boolean(row);
}

function listPayments({ startIso, endIso, limit = 500 } = {}) {
  let sql = 'SELECT * FROM payments WHERE 1=1';
  const params = [];

  if (startIso) {
    sql += ' AND received_at >= ?';
    params.push(startIso);
  }
  if (endIso) {
    sql += ' AND received_at <= ?';
    params.push(endIso);
  }

  sql += ' ORDER BY received_at DESC, id DESC LIMIT ?';
  params.push(Number(limit) || 500);

  const rows = db.prepare(sql).all(...params);
  const enriched = rows.map(enrichPaymentRow);
  const totalAmount = enriched.reduce((sum, p) => sum + Number(p.amount || 0), 0);

  return {
    payments: enriched,
    count: enriched.length,
    total_amount: Math.round(totalAmount * 100) / 100,
    formatted_total: NumberToSpanish.formatCOP(totalAmount)
  };
}

function deletePayment(id) {
  const info = db.prepare('DELETE FROM payments WHERE id = ?').run(Number(id));
  return info.changes > 0;
}

function clearTestPayments() {
  const info = db.prepare('DELETE FROM payments WHERE is_test = 1').run();
  return info.changes;
}

function logAuditEvent({ fromEmail, subject, reason, detail }) {
  db.prepare(`
    INSERT INTO audit_events (from_email, subject, reason, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    fromEmail || '',
    subject || '',
    reason || 'info',
    detail || '',
    new Date().toISOString()
  );

  db.exec(`
    DELETE FROM audit_events
    WHERE id NOT IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT 100)
  `);
}

function listAuditEvents(limit = 25) {
  return db
    .prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?')
    .all(Number(limit) || 25);
}

module.exports = {
  DB_PATH,
  getAllSettings,
  updateSettings,
  insertPayment,
  getPaymentById,
  hasMessageId,
  listPayments,
  deletePayment,
  clearTestPayments,
  logAuditEvent,
  listAuditEvents
};
