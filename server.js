const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const db = require('./src/db');
const parser = require('./src/parser');
const security = require('./src/security');
const emailWatcher = require('./src/emailWatcher');
const { generatePaymentsPdfStream } = require('./src/pdfReport');

const PORT = Number(process.env.PORT) || 3000;

function getColombiaDateParts(date = new Date()) {
  const bogotaMs = date.getTime() - 5 * 60 * 60 * 1000;
  const bogota = new Date(bogotaMs);
  const yyyy = bogota.getUTCFullYear();
  const mm = String(bogota.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(bogota.getUTCDate()).padStart(2, '0');
  return { yyyy, mm, dd, dateStr: `${yyyy}-${mm}-${dd}` };
}

function resolvePeriodRange(query = {}) {
  const period = String(query.period || 'today').toLowerCase();
  const now = new Date();
  const today = getColombiaDateParts(now);

  if (period === 'today') {
    return {
      period: 'today',
      periodLabel: `Hoy (${today.dateStr})`,
      startIso: new Date(`${today.dateStr}T00:00:00.000-05:00`).toISOString(),
      endIso: new Date(`${today.dateStr}T23:59:59.999-05:00`).toISOString()
    };
  }

  if (period === 'yesterday') {
    const yest = getColombiaDateParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    return {
      period: 'yesterday',
      periodLabel: `Ayer (${yest.dateStr})`,
      startIso: new Date(`${yest.dateStr}T00:00:00.000-05:00`).toISOString(),
      endIso: new Date(`${yest.dateStr}T23:59:59.999-05:00`).toISOString()
    };
  }

  if (period === '7days') {
    const startParts = getColombiaDateParts(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
    return {
      period: '7days',
      periodLabel: `Últimos 7 días (${startParts.dateStr} a ${today.dateStr})`,
      startIso: new Date(`${startParts.dateStr}T00:00:00.000-05:00`).toISOString(),
      endIso: new Date(`${today.dateStr}T23:59:59.999-05:00`).toISOString()
    };
  }

  if (period === 'month') {
    const monthStart = `${today.yyyy}-${today.mm}-01`;
    return {
      period: 'month',
      periodLabel: `Mes actual (${monthStart} a ${today.dateStr})`,
      startIso: new Date(`${monthStart}T00:00:00.000-05:00`).toISOString(),
      endIso: new Date(`${today.dateStr}T23:59:59.999-05:00`).toISOString()
    };
  }

  if (period === 'custom' && (query.start || query.end)) {
    const s = /^\d{4}-\d{2}-\d{2}$/.test(query.start || '') ? query.start : today.dateStr;
    const e = /^\d{4}-\d{2}-\d{2}$/.test(query.end || '') ? query.end : today.dateStr;
    return {
      period: 'custom',
      periodLabel: `Del ${s} al ${e}`,
      startIso: new Date(`${s}T00:00:00.000-05:00`).toISOString(),
      endIso: new Date(`${e}T23:59:59.999-05:00`).toISOString()
    };
  }

  return {
    period: 'all',
    periodLabel: 'Todos los pagos registrados',
    startIso: null,
    endIso: null
  };
}

function getLocalLanAddresses(port) {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const [name, list] of Object.entries(nets)) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const lowerName = name.toLowerCase();
      const isVirtual =
        lowerName.includes('wsl') ||
        lowerName.includes('vethernet') ||
        lowerName.includes('docker') ||
        lowerName.includes('virtualbox') ||
        lowerName.includes('vmware') ||
        lowerName.includes('loopback');

      const priority = isVirtual
        ? 3
        : lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wlan')
          ? 1
          : 2;

      candidates.push({
        interface: name,
        ip: iface.address,
        url: `http://${iface.address}:${port}`,
        isVirtual,
        priority
      });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates;
}

function extractClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').toLowerCase();
  return proto.includes('https');
}

function buildSessionCookieHeaders(token, clearFlag, secureFlag) {
  const securePart = secureFlag ? '; Secure' : '';
  const clearLegacy = `bcol_auth_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${securePart}`;

  if (clearFlag || !token) {
    return [
      `${security.SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${securePart}`,
      clearLegacy
    ];
  }

  // Cookie de sesión estricta (sin Max-Age persistente en disco y SameSite=Strict)
  return [
    `${security.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict${securePart}`,
    clearLegacy
  ];
}

// Ocultar información sensible (correos, servidores, remitentes internos) a usuarios viewer (celulares)
function sanitizeSettingsForRole(settings, role) {
  if (role === 'admin') return settings;
  return {
    business_name: settings.business_name || 'Control de Pagos Bancolombia',
    voice_enabled_default: settings.voice_enabled_default || 'true',
    has_password: Boolean(settings.has_password)
  };
}

function sanitizeWatcherStatusForRole(status, role) {
  if (!status || role === 'admin') return status;
  const safeMsg =
    status.state === 'connected'
      ? 'Monitoreo Turbo activo en tiempo real (1.5 s)'
      : status.state === 'connecting'
        ? 'Conectando al servidor de notificaciones...'
        : 'En espera de activación por el Administrador';

  return {
    state: status.state,
    message: safeMsg,
    lastCheckAt: status.lastCheckAt,
    hasPassword: Boolean(status.hasPassword),
    officialSenders: ['Entidad Oficial Autorizada']
  };
}

function sanitizePaymentForRole(payment, role) {
  if (!payment || role === 'admin') return payment;
  return {
    id: payment.id,
    amount: payment.amount,
    formatted_amount: payment.formatted_amount,
    voice_phrase: payment.voice_phrase,
    channel: payment.channel,
    payer: payment.payer,
    reference: payment.reference,
    sender_email: 'Correo Oficial Verificado',
    is_test: payment.is_test,
    received_at: payment.received_at
  };
}

function createAppServer({
  autoStartWatcher = true,
  authConfig = security.DEFAULT_ACCOUNTS
} = {}) {
  const app = express();
  const loginLimiter = new security.LoginRateLimiter({
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000
  });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
    next();
  });

  app.use(express.json({ limit: '512kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });

  const connectedClients = new Map();

  function getDevicesList() {
    const byAccount = new Map();
    for (const [id, info] of connectedClients.entries()) {
      const key = info.accountId || id;
      byAccount.set(key, {
        id,
        name: info.accountLabel ? `${info.accountLabel} (${info.name})` : info.name,
        role: info.role,
        deviceType: info.deviceType,
        voiceEnabled: info.voiceEnabled,
        connectedAt: info.connectedAt
      });
    }
    return Array.from(byAccount.values());
  }

  function broadcastByRole(buildPayloadForRole) {
    const adminRaw = JSON.stringify(buildPayloadForRole('admin'));
    const viewerPayload = buildPayloadForRole('viewer');
    const viewerRaw = viewerPayload ? JSON.stringify(viewerPayload) : null;

    for (const entry of connectedClients.values()) {
      if (entry.ws.readyState !== 1) continue;
      if (entry.role === 'admin') {
        entry.ws.send(adminRaw);
      } else if (viewerRaw) {
        entry.ws.send(viewerRaw);
      }
    }
  }

  function broadcastDevicesToAdmins() {
    const list = getDevicesList();
    broadcastByRole((role) =>
      role === 'admin'
        ? { type: 'devices', devices: list }
        : { type: 'devices', devices: [] }
    );
  }

  function inspectReqSession(req) {
    const cookies = security.parseCookies(req.headers.cookie);
    const token = cookies[security.SESSION_COOKIE_NAME];
    if (!token) return { valid: false, reason: 'missing' };
    const checked = security.inspectSessionToken(token);
    if (!checked.valid) return checked;
    return { valid: true, token, payload: checked.payload };
  }

  function getVerifiedSessionFromReq(req) {
    const res = inspectReqSession(req);
    return res.valid ? { token: res.token, payload: res.payload } : null;
  }

  function requireAuth(req, res, next) {
    const check = inspectReqSession(req);
    if (!check.valid) {
      const replaced = check.reason === 'replaced';
      return res.status(401).json({
        ok: false,
        authRequired: true,
        sessionReplaced: replaced,
        error: replaced
          ? 'Tu sesión se cerró porque este usuario inició sesión en otro navegador o dispositivo.'
          : 'Acceso restringido. Debes iniciar sesión.'
      });
    }
    req.userSession = { token: check.token, payload: check.payload };
    return next();
  }

  function requireAdmin(req, res, next) {
    const check = inspectReqSession(req);
    if (!check.valid) {
      const replaced = check.reason === 'replaced';
      return res.status(401).json({
        ok: false,
        authRequired: true,
        sessionReplaced: replaced,
        error: replaced
          ? 'Tu sesión se cerró porque este usuario inició sesión en otro navegador o dispositivo.'
          : 'Acceso restringido. Debes iniciar sesión.'
      });
    }
    if (check.payload.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        forbidden: true,
        error: 'Permiso denegado: esta función es exclusiva del Administrador.'
      });
    }
    req.userSession = { token: check.token, payload: check.payload };
    return next();
  }

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, status: 'healthy' });
  });

  // --- AUTENTICACIÓN DE ROLES (ADMIN Y CELULARES SOLO LECTURA) ---
  app.get('/api/auth/session', (req, res) => {
    const session = getVerifiedSessionFromReq(req);
    if (!session) {
      return res.json({ ok: true, authenticated: false });
    }
    return res.json({
      ok: true,
      authenticated: true,
      role: session.payload.role,
      label: session.payload.label
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const ip = extractClientIp(req);
    const rateCheck = loginLimiter.check(ip);
    if (rateCheck.blocked) {
      const mins = Math.ceil(rateCheck.retryAfterSeconds / 60);
      return res.status(429).json({
        ok: false,
        error: `Demasiados intentos fallidos. Acceso bloqueado temporalmente por ${mins} minuto(s) por seguridad.`
      });
    }

    const { username, password } = req.body || {};
    const check = security.verifyAccountCredentials(username, password, authConfig);

    if (!check.valid) {
      loginLimiter.recordFailure(ip);
      await new Promise((r) => setTimeout(r, 350));
      return res.status(401).json({
        ok: false,
        error: 'Usuario o contraseña incorrectos.'
      });
    }

    loginLimiter.reset(ip);
    const sessionData = security.createSessionToken({
      role: check.role,
      accountId: check.accountId,
      label: check.label
    });

    // Expulsar en tiempo real cualquier sesión anterior abierta con este mismo usuario en otro navegador/teléfono
    for (const [clientId, entry] of connectedClients.entries()) {
      if (entry.accountId === sessionData.accountId && entry.sessionToken !== sessionData.token) {
        try {
          if (entry.ws.readyState === 1) {
            entry.ws.send(
              JSON.stringify({
                type: 'session_replaced',
                message: '🔒 Tu sesión se cerró porque este usuario inició sesión en otro navegador o dispositivo.'
              })
            );
          }
          entry.ws.close(4002, 'Sesión iniciada en otro navegador');
        } catch (_) {}
        connectedClients.delete(clientId);
      }
    }
    broadcastDevicesToAdmins();

    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeaders(sessionData.token, false, isSecureRequest(req))
    );

    return res.json({
      ok: true,
      authenticated: true,
      role: check.role,
      label: check.label
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const cookies = security.parseCookies(req.headers.cookie);
    const token = cookies[security.SESSION_COOKIE_NAME];
    if (token) {
      security.revokeSessionToken(token);
      for (const [id, entry] of connectedClients.entries()) {
        if (entry.sessionToken === token) {
          try {
            entry.ws.close(4001, 'Sesión cerrada');
          } catch (_) {}
          connectedClients.delete(id);
        }
      }
      broadcastDevicesToAdmins();
    }

    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeaders('', true, isSecureRequest(req))
    );
    res.json({ ok: true, authenticated: false });
  });

  // --- LECTURA PERMITIDA TANTO A ADMIN COMO A CELULARES (CON REDACCIÓN PARA VIEWER) ---
  app.get('/api/state', requireAuth, (req, res) => {
    const role = req.userSession.payload.role;
    const rawSettings = db.getAllSettings(false);
    const rawWatcher = emailWatcher.getStatus();

    res.json({
      ok: true,
      role,
      userLabel: req.userSession.payload.label,
      settings: sanitizeSettingsForRole(rawSettings, role),
      encryptedVault: db.exportEncryptedVault(),
      watcherStatus: sanitizeWatcherStatusForRole(rawWatcher, role),
      devices: role === 'admin' ? getDevicesList() : [],
      officialPresets: role === 'admin' ? parser.DEFAULT_BANCOLOMBIA_SENDERS : [],
      auditEvents: role === 'admin' ? db.listAuditEvents(15) : []
    });
  });

  // Restauración de bóveda sellada AES-256-GCM (firmada criptográficamente por el servidor, ilegible afuera)
  app.post('/api/settings/restore-vault', requireAuth, async (req, res) => {
    const role = req.userSession.payload.role;
    const { encryptedVault } = req.body || {};
    const result = db.restoreEncryptedVault(encryptedVault);

    if (result.restoredSettings && autoStartWatcher) {
      emailWatcher.restart().catch(() => {});
    }

    const freshVault = db.exportEncryptedVault();
    if (result.restored) {
      const fullSettings = db.getAllSettings(false);
      const fullStatus = emailWatcher.getStatus();
      broadcastByRole((r) => ({
        type: 'settings_updated',
        settings: sanitizeSettingsForRole(fullSettings, r),
        encryptedVault: freshVault,
        watcherStatus: sanitizeWatcherStatusForRole(fullStatus, r)
      }));
      if (result.restoredPaymentsCount > 0) {
        broadcastByRole(() => ({ type: 'payments_changed' }));
      }
    }

    res.json({
      ok: true,
      restored: result.restored,
      settings: sanitizeSettingsForRole(db.getAllSettings(false), role),
      encryptedVault: freshVault,
      watcherStatus: sanitizeWatcherStatusForRole(emailWatcher.getStatus(), role)
    });
  });

  app.get('/api/payments', requireAuth, (req, res) => {
    const role = req.userSession.payload.role;
    const range = resolvePeriodRange(req.query);
    const data = db.listPayments({
      startIso: range.startIso,
      endIso: range.endIso,
      limit: 1000
    });
    res.json({
      ok: true,
      ...range,
      count: data.count,
      total_amount: data.total_amount,
      formatted_total: data.formatted_total,
      payments: data.payments.map((p) => sanitizePaymentForRole(p, role))
    });
  });

  app.post('/api/email/check-now', requireAuth, async (req, res) => {
    const role = req.userSession.payload.role;
    const result = await emailWatcher.checkNow({ manual: true });
    res.json({
      ok: true,
      checked: result.checked,
      added: result.added,
      watcherStatus: sanitizeWatcherStatusForRole(emailWatcher.getStatus(), role)
    });
  });

  // --- PODERES EXCLUSIVOS DE ROL ADMIN (BLOQUEADOS CON 403 PARA CELULARES) ---
  app.get('/api/network-info', requireAdmin, async (req, res) => {
    const actualPort = (server.address() && server.address().port) || PORT;
    const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
    const reqProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
      .split(',')[0]
      .trim();
    const isLocalHostHeader =
      !reqHost ||
      reqHost.startsWith('localhost') ||
      reqHost.startsWith('127.0.0.1') ||
      /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(reqHost);

    const cloudExternalUrl =
      process.env.RENDER_EXTERNAL_URL || (!isLocalHostHeader ? `${reqProto}://${reqHost}` : '');

    if (cloudExternalUrl) {
      const cleanUrl = cloudExternalUrl.replace(/\/+$/, '');
      const qrLoginUrl = `${cleanUrl}/?login=1`;
      const qrDataUrl = await QRCode.toDataURL(qrLoginUrl, {
        margin: 1,
        width: 280,
        color: { dark: '#0F172A', light: '#FFFFFF' }
      });

      return res.json({
        ok: true,
        isCloud: true,
        port: actualPort,
        primaryUrl: cleanUrl,
        primaryIp: cleanUrl,
        qrDataUrl,
        addresses: [
          {
            interface: 'Nube segura (Acceso autenticado)',
            ip: cleanUrl,
            url: cleanUrl,
            isVirtual: false
          }
        ],
        devices: getDevicesList()
      });
    }

    const addresses = getLocalLanAddresses(actualPort);
    const selectedIp = req.query.ip;
    const primary =
      addresses.find((a) => a.ip === selectedIp) ||
      addresses[0] || {
        interface: 'Localhost',
        ip: '127.0.0.1',
        url: `http://localhost:${actualPort}`,
        isVirtual: false
      };

    const qrDataUrl = await QRCode.toDataURL(`${primary.url}/?login=1`, {
      margin: 1,
      width: 280,
      color: { dark: '#0F172A', light: '#FFFFFF' }
    });

    return res.json({
      ok: true,
      isCloud: false,
      port: actualPort,
      primaryUrl: primary.url,
      primaryIp: primary.ip,
      qrDataUrl,
      addresses,
      devices: getDevicesList()
    });
  });

  app.get('/api/report/pdf', requireAdmin, (req, res) => {
    const range = resolvePeriodRange(req.query);
    const data = db.listPayments({
      startIso: range.startIso,
      endIso: range.endIso,
      limit: 5000
    });
    const settings = db.getAllSettings(false);
    const today = getColombiaDateParts();

    const safeFileName = `Reporte_Pagos_Bancolombia_${range.period}_${today.dateStr}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"`);

    generatePaymentsPdfStream({
      res,
      businessName: settings.business_name,
      periodLabel: range.periodLabel,
      officialSenders: parser.normalizeSenderList(settings.official_senders),
      payments: data.payments,
      totalAmount: data.total_amount
    });
  });

  app.post('/api/settings', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const prev = db.getAllSettings(true);

    const updated = db.updateSettings({
      business_name: body.business_name,
      email_provider: body.email_provider,
      email_user: body.email_user,
      email_pass: body.email_pass,
      imap_host: body.imap_host,
      imap_port: body.imap_port,
      imap_tls: body.imap_tls,
      official_senders: body.official_senders,
      sync_lookback: body.sync_lookback,
      voice_enabled_default: body.voice_enabled_default
    });

    const after = db.getAllSettings(true);
    const imapChanged =
      prev.email_provider !== after.email_provider ||
      prev.email_user !== after.email_user ||
      prev.email_pass !== after.email_pass ||
      prev.imap_host !== after.imap_host ||
      prev.imap_port !== after.imap_port ||
      prev.sync_lookback !== after.sync_lookback;

    if (autoStartWatcher) {
      if (imapChanged) {
        emailWatcher.restart().catch(() => {});
      } else {
        emailWatcher.emit('status', emailWatcher.getStatus());
      }
    }

    const freshVault = db.exportEncryptedVault();
    const fullStatus = emailWatcher.getStatus();

    broadcastByRole((r) => ({
      type: 'settings_updated',
      settings: sanitizeSettingsForRole(updated, r),
      encryptedVault: freshVault,
      watcherStatus: sanitizeWatcherStatusForRole(fullStatus, r)
    }));

    res.json({
      ok: true,
      settings: updated,
      encryptedVault: freshVault,
      watcherStatus: fullStatus
    });
  });

  app.post('/api/email/test-connection', requireAdmin, async (req, res) => {
    const result = await emailWatcher.testConnection(req.body || {});
    res.json(result);
  });

  app.post('/api/payments/simulate', requireAdmin, (req, res) => {
    const body = req.body || {};
    const settings = db.getAllSettings(false);
    const officialList = parser.normalizeSenderList(settings.official_senders);
    const sender = (body.sender_email || officialList[0] || 'jhocamza@gmail.com').trim();
    const rawAmount = body.amount || 50000;
    const channel = body.channel || 'Transferencia Bancolombia';
    const payer = body.payer || 'CLIENTE DE PRUEBA';

    const simulatedSubject = 'Bancolombia le informa recepción de pago';
    const simulatedBody = `Bancolombia: Recibiste una transferencia por $${Number(rawAmount).toLocaleString('es-CO')} de ${payer} mediante ${channel}. Comprobante TEST-${Math.floor(100000 + Math.random() * 900000)}.`;

    const analysis = parser.analyzeEmailForPayment({
      fromAddress: sender,
      fromName: 'Simulador de Prueba',
      subject: simulatedSubject,
      textBody: simulatedBody,
      htmlBody: '',
      date: new Date(),
      messageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      headers: new Map([['authentication-results', 'spf=pass dkim=pass']]),
      officialSenders: settings.official_senders
    });

    if (!analysis.accepted) {
      return res.status(400).json({
        ok: false,
        error: analysis.reasonDetail
      });
    }

    const { payment } = db.insertPayment(analysis.payment, true);
    const freshVault = db.exportEncryptedVault();

    broadcastByRole((r) => ({
      type: 'new_payment',
      payment: sanitizePaymentForRole(payment, r),
      encryptedVault: freshVault,
      announceVoice: true
    }));

    return res.json({
      ok: true,
      payment
    });
  });

  app.delete('/api/payments-test', requireAdmin, (req, res) => {
    const deletedCount = db.clearTestPayments();
    const freshVault = db.exportEncryptedVault();
    broadcastByRole(() => ({ type: 'payments_changed', encryptedVault: freshVault }));
    res.json({ ok: true, deletedCount });
  });

  app.delete('/api/payments/:id', requireAdmin, (req, res) => {
    const deleted = db.deletePayment(req.params.id);
    const freshVault = db.exportEncryptedVault();
    broadcastByRole(() => ({ type: 'payments_changed', encryptedVault: freshVault }));
    res.json({ ok: true, deleted });
  });

  // WebSocket autenticado para Administrador y Celulares (viewer)
  wss.on('connection', (ws, req) => {
    const cookies = security.parseCookies(req.headers.cookie);
    const token = cookies[security.SESSION_COOKIE_NAME];
    const verified = security.verifySessionToken(token);

    if (!verified) {
      ws.close(4001, 'No autorizado');
      return;
    }

    const id = crypto.randomUUID();
    const ua = String(req.headers['user-agent'] || '');
    const isMobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
    const defaultName = /iphone|ipad/i.test(ua)
      ? 'iPhone'
      : /android/i.test(ua)
        ? 'Android'
        : 'PC';

    // Si la misma cuenta abre otra pestaña o reconecta, cerrar el socket viejo para garantizar 1 sola conexión viva por usuario
    for (const [oldId, oldEntry] of connectedClients.entries()) {
      if (oldEntry.accountId === verified.accountId) {
        try {
          if (oldEntry.sessionToken !== token && oldEntry.ws.readyState === 1) {
            oldEntry.ws.send(
              JSON.stringify({
                type: 'session_replaced',
                message: '🔒 Tu sesión se cerró porque este usuario inició sesión en otro navegador o dispositivo.'
              })
            );
          }
          oldEntry.ws.close(oldEntry.sessionToken !== token ? 4002 : 4003, 'Reemplazada por conexión más reciente');
        } catch (_) {}
        connectedClients.delete(oldId);
      }
    }

    const clientEntry = {
      ws,
      sessionToken: token,
      accountId: verified.accountId,
      role: verified.role,
      accountLabel: verified.label,
      isAlive: true,
      name: defaultName,
      deviceType: isMobile || verified.role === 'viewer' ? 'phone' : 'pc',
      voiceEnabled: true,
      connectedAt: new Date().toISOString()
    };

    connectedClients.set(id, clientEntry);
    broadcastDevicesToAdmins();

    ws.on('pong', () => {
      clientEntry.isAlive = true;
    });

    ws.on('message', (raw) => {
      if (!security.verifySessionToken(clientEntry.sessionToken)) {
        ws.close(4001, 'Sesión expirada');
        return;
      }
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'hello' || msg.type === 'update_device') {
          if (typeof msg.voiceEnabled === 'boolean') {
            clientEntry.voiceEnabled = msg.voiceEnabled;
          }
          broadcastDevicesToAdmins();
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      connectedClients.delete(id);
      broadcastDevicesToAdmins();
    });
  });

  const wsHeartbeat = setInterval(() => {
    for (const [id, entry] of connectedClients.entries()) {
      if (!entry.isAlive || !security.verifySessionToken(entry.sessionToken)) {
        entry.ws.terminate();
        connectedClients.delete(id);
        continue;
      }
      entry.isAlive = false;
      try {
        entry.ws.ping();
      } catch (_) {}
    }
  }, 25000);

  server.on('close', () => {
    clearInterval(wsHeartbeat);
  });

  emailWatcher.on('payment', ({ payment, announceVoice }) => {
    const freshVault = db.exportEncryptedVault();
    broadcastByRole((r) => ({
      type: 'new_payment',
      payment: sanitizePaymentForRole(payment, r),
      encryptedVault: freshVault,
      announceVoice
    }));
  });

  emailWatcher.on('status', (status) => {
    broadcastByRole((r) => ({
      type: 'watcher_status',
      status: sanitizeWatcherStatusForRole(status, r)
    }));
  });

  emailWatcher.on('audit', (event) => {
    broadcastByRole((r) => (r === 'admin' ? { type: 'audit_event', event } : null));
  });

  if (autoStartWatcher) {
    emailWatcher.start().catch(() => {});
  }

  return { app, server, wss, emailWatcher };
}

if (require.main === module) {
  const { server } = createAppServer({ autoStartWatcher: true });
  server.listen(PORT, '0.0.0.0', () => {
    const lanList = getLocalLanAddresses(PORT);
    console.log('\n============================================================');
    console.log('  CONTROL DE PAGOS BANCOLOMBIA - SERVIDOR PROTEGIDO ACTIVO');
    console.log('============================================================');
    console.log(`  En este computador:   http://localhost:${PORT}`);
    if (lanList.length > 0) {
      console.log(`  Para tus teléfonos:   ${lanList[0].url}  (${lanList[0].interface})`);
    }
    console.log('============================================================\n');
  });
}

module.exports = {
  createAppServer,
  resolvePeriodRange,
  getColombiaDateParts
};
