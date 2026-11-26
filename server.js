const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const db = require('./src/db');
const parser = require('./src/parser');
const emailWatcher = require('./src/emailWatcher');
const { generatePaymentsPdfStream } = require('./src/pdfReport');

const PORT = Number(process.env.PORT) || 3000;

function getColombiaDateParts(date = new Date()) {
  // Colombia siempre es UTC-5 sin horario de verano
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

function createAppServer({ autoStartWatcher = true } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Registro de pantallas/teléfonos conectados
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

  // Middleware de PIN opcional para proteger el acceso en Wi-Fi abiertas
  function checkPinMiddleware(req, res, next) {
    const settings = db.getAllSettings(true);
    const requiredPin = (settings.access_pin || '').trim();
    if (!requiredPin) return next();

    const provided = String(req.headers['x-access-pin'] || req.query.pin || '').trim();
    if (provided === requiredPin) return next();

    return res.status(401).json({
      ok: false,
      pinRequired: true,
      error: 'Se requiere el PIN de acceso configurado.'
    });
  }

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, status: 'healthy', timestamp: new Date().toISOString() });
  });

  app.get('/api/ping-auth', (req, res) => {
    const settings = db.getAllSettings(true);
    const requiredPin = (settings.access_pin || '').trim();
    const provided = String(req.headers['x-access-pin'] || req.query.pin || '').trim();
    res.json({
      ok: true,
      pinRequired: Boolean(requiredPin),
      authorized: !requiredPin || provided === requiredPin
    });
  });

  app.get('/api/state', checkPinMiddleware, (req, res) => {
    res.json({
      ok: true,
      settings: db.getAllSettings(false),
      watcherStatus: emailWatcher.getStatus(),
      devices: getDevicesList(),
      officialPresets: parser.DEFAULT_BANCOLOMBIA_SENDERS,
      auditEvents: db.listAuditEvents(15)
    });
  });

  app.get('/api/network-info', checkPinMiddleware, async (req, res) => {
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

    // Si corre en Render o dominio público en la nube, el QR apunta directo a la URL pública HTTPS
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
            interface: 'Nube (Acceso desde cualquier red / datos móviles)',
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

  app.get('/api/payments', checkPinMiddleware, (req, res) => {
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

  app.get('/api/report/pdf', checkPinMiddleware, (req, res) => {
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

  app.post('/api/settings', checkPinMiddleware, async (req, res) => {
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
      voice_enabled_default: body.voice_enabled_default,
      access_pin: body.access_pin
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

    broadcast({
      type: 'settings_updated',
      settings: updated,
      watcherStatus: emailWatcher.getStatus()
    });

    res.json({
      ok: true,
      settings: updated,
      watcherStatus: emailWatcher.getStatus()
    });
  });

  app.post('/api/email/test-connection', checkPinMiddleware, async (req, res) => {
    const result = await emailWatcher.testConnection(req.body || {});
    res.json(result);
  });

  app.post('/api/email/check-now', checkPinMiddleware, async (req, res) => {
    const result = await emailWatcher.checkNow({ manual: true });
    res.json({
      ok: true,
      ...result,
      watcherStatus: emailWatcher.getStatus()
    });
  });

  app.post('/api/payments/simulate', checkPinMiddleware, (req, res) => {
    const body = req.body || {};
    const settings = db.getAllSettings(false);
    const officialList = parser.normalizeSenderList(settings.official_senders);
    const sender = (body.sender_email || officialList[0] || 'jhocamza@gmail.com').trim();
    const rawAmount = body.amount || 50000;
    const channel = body.channel || 'Transferencia Bancolombia';
    const payer = body.payer || 'CLIENTE DE PRUEBA';

    // Pasarlo por el mismo motor analizador para probar toda la cadena real
    const simulatedSubject = `Bancolombia le informa recepción de pago`;
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

  app.delete('/api/payments-test', checkPinMiddleware, (req, res) => {
    const deletedCount = db.clearTestPayments();
    broadcast({ type: 'payments_changed' });
    res.json({ ok: true, deletedCount });
  });

  app.delete('/api/payments/:id', checkPinMiddleware, (req, res) => {
    const deleted = db.deletePayment(req.params.id);
    broadcast({ type: 'payments_changed' });
    res.json({ ok: true, deleted });
  });

  // Eventos WebSocket para sincronizar PC y 2-3 teléfonos en vivo
  wss.on('connection', (ws, req) => {
    const settings = db.getAllSettings(true);
    const requiredPin = (settings.access_pin || '').trim();
    const urlObj = new URL(req.url, 'http://localhost');
    const providedPin = (urlObj.searchParams.get('pin') || '').trim();

    if (requiredPin && providedPin !== requiredPin) {
      ws.close(4001, 'PIN requerido');
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
      if (!entry.isAlive) {
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

  // Conectar eventos de EmailWatcher hacia WebSocket
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
    console.log('  CONTROL DE PAGOS BANCOLOMBIA - SERVIDOR ACTIVO');
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
