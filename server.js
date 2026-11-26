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

function buildSessionCookieHeader(token, maxAgeSeconds, secureFlag) {
  const parts = [
    `${security.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax'
  ];
  if (secureFlag) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function createAppServer({
  autoStartWatcher = true,
  authConfig = security.DEFAULT_ADMIN_AUTH
} = {}) {
  const app = express();
  const loginLimiter = new security.LoginRateLimiter({
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000
  });

  // Cabeceras de seguridad endurecidas
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

  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });

  const connectedClients = new Map();

  function getDevicesList() {
    const arr = [];
    for (const [id, info] of connectedClients.entries()) {
      arr.push({
        id,
        name: info.name,
        deviceType: info.deviceType,
        voiceEnabled: info.voiceEnabled,
        connectedAt: info.connectedAt
      });
    }
    return arr;
  }

  function broadcast(payload) {
    const raw = JSON.stringify(payload);
    for (const { ws } of connectedClients.values()) {
      if (ws.readyState === 1) {
        ws.send(raw);
      }
    }
  }

  function getVerifiedSessionFromReq(req) {
    const cookies = security.parseCookies(req.headers.cookie);
    const token = cookies[security.SESSION_COOKIE_NAME];
    if (!token) return null;
    const payload = security.verifySessionToken(token);
    if (!payload) return null;
    return { token, payload };
  }

  function requireAuth(req, res, next) {
    const session = getVerifiedSessionFromReq(req);
    if (!session) {
      return res.status(401).json({
        ok: false,
        authRequired: true,
        error: 'Acceso restringido. Debes iniciar sesión.'
      });
    }
    req.adminSession = session;
    return next();
  }

  // Healthcheck para Render (no expone ningún dato privado)
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, status: 'healthy' });
  });

  // --- ENDPOINTS DE AUTENTICACIÓN (SIN OPCIÓN DE CAMBIAR CLAVE POR INTERFAZ) ---
  app.get('/api/auth/session', (req, res) => {
    const session = getVerifiedSessionFromReq(req);
    res.json({
      ok: true,
      authenticated: Boolean(session)
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
    const valid = security.verifyAdminCredentials(username, password, authConfig);

    if (!valid) {
      loginLimiter.recordFailure(ip);
      // Pequeña pausa adicional contra fuerza bruta automatizada
      await new Promise((r) => setTimeout(r, 350));
      return res.status(401).json({
        ok: false,
        error: 'Usuario o contraseña incorrectos.'
      });
    }

    loginLimiter.reset(ip);
    const token = security.createSessionToken();
    const maxAgeSec = Math.floor(security.SESSION_TTL_MS / 1000);
    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeader(token, maxAgeSec, isSecureRequest(req))
    );

    return res.json({
      ok: true,
      authenticated: true
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const cookies = security.parseCookies(req.headers.cookie);
    const token = cookies[security.SESSION_COOKIE_NAME];
    if (token) {
      security.revokeSessionToken(token);
      // Cerrar WebSockets asociados a ese token de sesión
      for (const [id, entry] of connectedClients.entries()) {
        if (entry.sessionToken === token) {
          try {
            entry.ws.close(4001, 'Sesión cerrada');
          } catch (_) {}
          connectedClients.delete(id);
        }
      }
      broadcast({ type: 'devices', devices: getDevicesList() });
    }

    res.setHeader(
      'Set-Cookie',
      buildSessionCookieHeader('', 0, isSecureRequest(req))
    );
    res.json({ ok: true, authenticated: false });
  });

  // --- TODOS LOS ENDPOINTS SIGUIENTES EXIGEN SESIÓN VÁLIDA ---
  app.get('/api/state', requireAuth, (req, res) => {
    res.json({
      ok: true,
      settings: db.getAllSettings(false),
      encryptedVault: db.exportEncryptedVault(),
      watcherStatus: emailWatcher.getStatus(),
      devices: getDevicesList(),
      officialPresets: parser.DEFAULT_BANCOLOMBIA_SENDERS,
      auditEvents: db.listAuditEvents(15)
    });
  });

  app.post('/api/settings/restore-vault', requireAuth, async (req, res) => {
    const { encryptedVault } = req.body || {};
    const result = db.restoreEncryptedVault(encryptedVault);

    if (result.restored && autoStartWatcher) {
      emailWatcher.restart().catch(() => {});
    }

    const freshVault = db.exportEncryptedVault();
    if (result.restored) {
      broadcast({
        type: 'settings_updated',
        settings: result.settings,
        encryptedVault: freshVault,
        watcherStatus: emailWatcher.getStatus()
      });
    }

    res.json({
      ok: true,
      restored: result.restored,
      settings: db.getAllSettings(false),
      encryptedVault: freshVault,
      watcherStatus: emailWatcher.getStatus()
    });
  });

  app.get('/api/network-info', requireAuth, async (req, res) => {
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
      const qrDataUrl = await QRCode.toDataURL(cleanUrl, {
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

    const qrDataUrl = await QRCode.toDataURL(primary.url, {
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

  app.get('/api/payments', requireAuth, (req, res) => {
    const range = resolvePeriodRange(req.query);
    const data = db.listPayments({
      startIso: range.startIso,
      endIso: range.endIso,
      limit: 1000
    });
    res.json({
      ok: true,
      ...range,
      ...data
    });
  });

  app.get('/api/report/pdf', requireAuth, (req, res) => {
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

  app.post('/api/settings', requireAuth, async (req, res) => {
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

    broadcast({
      type: 'settings_updated',
      settings: updated,
      encryptedVault: freshVault,
      watcherStatus: emailWatcher.getStatus()
    });

    res.json({
      ok: true,
      settings: updated,
      encryptedVault: freshVault,
      watcherStatus: emailWatcher.getStatus()
    });
  });

  app.post('/api/email/test-connection', requireAuth, async (req, res) => {
    const result = await emailWatcher.testConnection(req.body || {});
    res.json(result);
  });

  app.post('/api/email/check-now', requireAuth, async (req, res) => {
    const result = await emailWatcher.checkNow({ manual: true });
    res.json({
      ok: true,
      ...result,
      watcherStatus: emailWatcher.getStatus()
    });
  });

  app.post('/api/payments/simulate', requireAuth, (req, res) => {
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
    broadcast({
      type: 'new_payment',
      payment,
      announceVoice: true
    });

    return res.json({
      ok: true,
      payment
    });
  });

  app.delete('/api/payments-test', requireAuth, (req, res) => {
    const deletedCount = db.clearTestPayments();
    broadcast({ type: 'payments_changed' });
    res.json({ ok: true, deletedCount });
  });

  app.delete('/api/payments/:id', requireAuth, (req, res) => {
    const deleted = db.deletePayment(req.params.id);
    broadcast({ type: 'payments_changed' });
    res.json({ ok: true, deleted });
  });

  // WebSocket exige cookie de sesión HttpOnly válida
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
      ? 'iPhone / iPad'
      : /android/i.test(ua)
        ? 'Teléfono Android'
        : 'Computador Principal';

    const clientEntry = {
      ws,
      sessionToken: token,
      isAlive: true,
      name: defaultName,
      deviceType: isMobile ? 'phone' : 'pc',
      voiceEnabled: true,
      connectedAt: new Date().toISOString()
    };

    connectedClients.set(id, clientEntry);
    broadcast({ type: 'devices', devices: getDevicesList() });

    ws.on('pong', () => {
      clientEntry.isAlive = true;
    });

    ws.on('message', (raw) => {
      // Re-verificar que el token no haya expirado ni sido revocado
      if (!security.verifySessionToken(clientEntry.sessionToken)) {
        ws.close(4001, 'Sesión expirada');
        return;
      }
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'hello' || msg.type === 'update_device') {
          if (msg.name) clientEntry.name = String(msg.name).slice(0, 40);
          if (typeof msg.voiceEnabled === 'boolean') {
            clientEntry.voiceEnabled = msg.voiceEnabled;
          }
          broadcast({ type: 'devices', devices: getDevicesList() });
        }
      } catch (_) {}
    });

    ws.on('close', () => {
      connectedClients.delete(id);
      broadcast({ type: 'devices', devices: getDevicesList() });
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
    broadcast({
      type: 'new_payment',
      payment,
      announceVoice
    });
  });

  emailWatcher.on('status', (status) => {
    broadcast({
      type: 'watcher_status',
      status
    });
  });

  emailWatcher.on('audit', (event) => {
    broadcast({
      type: 'audit_event',
      event
    });
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
