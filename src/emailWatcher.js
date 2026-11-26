const EventEmitter = require('node:events');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('./db');
const parser = require('./parser');

const PROVIDER_PRESETS = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
  hotmail: { host: 'outlook.office365.com', port: 993, secure: true },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true }
};

function resolveImapConfig(settings) {
  const provider = (settings.email_provider || 'gmail').toLowerCase();
  const preset = PROVIDER_PRESETS[provider];

  const host = preset ? preset.host : (settings.imap_host || '').trim();
  const port = preset ? preset.port : (Number(settings.imap_port) || 993);
  const secure = preset ? preset.secure : settings.imap_tls !== 'false';
  const user = (settings.email_user || '').trim();
  let pass = settings.email_pass || '';

  // En Gmail las contraseñas de aplicación suelen copiarse con espacios ("abcd efgh ijkl mnop")
  if (provider === 'gmail' && /^[a-zA-Z]{4}(\s+[a-zA-Z]{4}){3}$/.test(pass.trim())) {
    pass = pass.replace(/\s+/g, '');
  }

  return { provider, host, port, secure, user, pass };
}

function translateImapError(err, provider) {
  const raw = String((err && (err.responseText || err.message)) || err || '');
  const lower = raw.toLowerCase();

  if (
    lower.includes('application-specific password') ||
    lower.includes('invalid credentials') ||
    lower.includes('authenticationfailed') ||
    lower.includes('username and password not accepted') ||
    lower.includes('web login required')
  ) {
    if (provider === 'gmail') {
      return 'Gmail rechazó la clave. Recuerda que Gmail exige una "Contraseña de Aplicación" de 16 letras (no tu clave normal de correo). Revisa la guía paso a paso en Configuración.';
    }
    if (provider === 'hotmail') {
      return 'Hotmail/Outlook rechazó el acceso IMAP. Verifica que IMAP esté habilitado y usa una Contraseña de Aplicación de tu cuenta Microsoft (o reenvía los correos de Bancolombia a un Gmail).';
    }
    return 'Usuario o contraseña rechazados por el servidor de correo. Verifica tus credenciales o usa una Contraseña de Aplicación.';
  }

  if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
    return 'No se pudo conectar al servidor de correo (verifica tu conexión a internet o el servidor IMAP).';
  }

  if (lower.includes('etimedout') || lower.includes('timeout')) {
    return 'Tiempo de espera agotado al conectar con el servidor de correo.';
  }

  return `Error de correo: ${raw}`;
}

class EmailWatcher extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.running = false;
    this.scanning = false;
    this.lastSeenUid = 0;
    this.reconnectTimer = null;
    this.pollInterval = null;
    this.status = {
      state: 'unconfigured', // 'unconfigured' | 'connecting' | 'connected' | 'error' | 'stopped'
      message: 'Configura la Contraseña de Aplicación de tu correo para iniciar la lectura automática.',
      lastCheckAt: null,
      emailUser: '',
      provider: 'gmail',
      officialSenders: []
    };
  }

  getStatus() {
    const settings = db.getAllSettings(false);
    return {
      ...this.status,
      emailUser: settings.email_user || '',
      provider: settings.email_provider || 'gmail',
      officialSenders: parser.normalizeSenderList(settings.official_senders),
      hasPassword: Boolean(settings.has_password)
    };
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  async testConnection(candidateSettings) {
    const current = db.getAllSettings(true);
    const merged = {
      ...current,
      ...candidateSettings,
      email_pass:
        candidateSettings.email_pass === '__KEEP__' || !candidateSettings.email_pass
          ? current.email_pass
          : candidateSettings.email_pass
    };

    const cfg = resolveImapConfig(merged);
    if (!cfg.user || !cfg.pass || !cfg.host) {
      return {
        ok: false,
        error: 'Debes ingresar el correo electrónico y la contraseña / contraseña de aplicación.'
      };
    }

    const testClient = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000
    });

    testClient.on('error', () => {});

    try {
      await testClient.connect();
      const box = await testClient.mailboxOpen('INBOX');
      const totalMessages = box.exists || 0;
      await testClient.logout().catch(() => {});
      return {
        ok: true,
        message: `Conexión exitosa con ${cfg.user} (${totalMessages} mensajes en bandeja de entrada).`
      };
    } catch (err) {
      try {
        testClient.close();
      } catch (_) {}
      return {
        ok: false,
        error: translateImapError(err, cfg.provider)
      };
    }
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.client) {
      const c = this.client;
      this.client = null;
      try {
        await c.logout();
      } catch (_) {
        try {
          c.close();
        } catch (__) {}
      }
    }
  }

  async start() {
    const settings = db.getAllSettings(true);
    const cfg = resolveImapConfig(settings);

    if (!cfg.user || !cfg.pass || !cfg.host) {
      this.setStatus({
        state: 'unconfigured',
        message: 'Falta configurar la Contraseña de Aplicación del correo para monitorear en vivo.'
      });
      return;
    }

    this.running = true;
    this.lastSeenUid = 0;
    await this._connectLoop(cfg, settings);
  }

  async _connectLoop(cfg, settings) {
    if (!this.running) return;

    this.setStatus({
      state: 'connecting',
      message: `Conectando a ${cfg.user} (${cfg.host})...`
    });

    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      connectionTimeout: 20000,
      greetingTimeout: 15000
    });

    this.client = client;

    client.on('error', (err) => {
      if (!this.running || this.client !== client) return;
      this.setStatus({
        state: 'error',
        message: translateImapError(err, cfg.provider)
      });
      this._scheduleReconnect(10000);
    });

    client.on('close', () => {
      if (!this.running || this.client !== client) return;
      this.setStatus({
        state: 'connecting',
        message: 'Conexión cerrada por el servidor, reconectando automáticamente...'
      });
      this._scheduleReconnect(5000);
    });

    client.on('exists', () => {
      if (!this.running || this.client !== client) return;
      this.checkNow({ isLiveEvent: true }).catch(() => {});
    });

    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX');

      const lookback = settings.sync_lookback || 'today';
      if (lookback === 'now' && mailbox.uidNext) {
        this.lastSeenUid = Math.max(0, mailbox.uidNext - 1);
      }

      this.setStatus({
        state: 'connected',
        message: `Monitoreando ${cfg.user} en tiempo real`,
        lastCheckAt: new Date().toISOString()
      });

      // Escaneo inicial según configuración
      await this.checkNow({ isInitialScan: true });

      // Respaldo periódico cada 20s por si el router corta paquetes IDLE silenciosamente
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        if (this.running && this.client === client) {
          this.checkNow({ isLiveEvent: true }).catch(() => {});
        }
      }, 20000);
    } catch (err) {
      if (this.client === client) {
        this.client = null;
      }
      try {
        client.close();
      } catch (_) {}

      const friendly = translateImapError(err, cfg.provider);
      this.setStatus({
        state: 'error',
        message: friendly
      });

      // Si es error de credenciales no reintentar cada 5s agresivamente
      const isAuthErr = friendly.includes('rechazó');
      if (!isAuthErr && this.running) {
        this._scheduleReconnect(12000);
      }
    }
  }

  _scheduleReconnect(delayMs) {
    if (!this.running) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      const settings = db.getAllSettings(true);
      const cfg = resolveImapConfig(settings);
      this._connectLoop(cfg, settings);
    }, delayMs);
  }

  async checkNow({ isInitialScan = false, isLiveEvent = false, manual = false } = {}) {
    if (!this.client || !this.client.usable) {
      if (manual) {
        await this.restart();
      }
      return { checked: 0, added: 0 };
    }

    if (this.scanning) {
      return { checked: 0, added: 0, busy: true };
    }

    this.scanning = true;
    let checked = 0;
    let added = 0;

    try {
      const settings = db.getAllSettings(false);
      const officialSenders = parser.normalizeSenderList(settings.official_senders);
      const lookback = settings.sync_lookback || 'today';

      let searchQuery;
      if (this.lastSeenUid > 0 && !manual) {
        searchQuery = { uid: `${this.lastSeenUid + 1}:*` };
      } else {
        const sinceDate = new Date();
        if (lookback === '7days') {
          sinceDate.setDate(sinceDate.getDate() - 7);
          sinceDate.setHours(0, 0, 0, 0);
        } else {
          // Por defecto revisar correos de hoy (restando margen por zonas horarias IMAP)
          sinceDate.setHours(0, 0, 0, 0);
        }
        searchQuery = { since: sinceDate };
      }

      const uids = await this.client.search(searchQuery, { uid: true });
      const validUids = (uids || []).filter((uid) => (manual ? true : uid > this.lastSeenUid));

      // Limitar a los últimos 60 mensajes en escaneo inicial/manual para máxima velocidad
      const targetUids = validUids.slice(-60);

      if (targetUids.length > 0) {
        for await (const msg of this.client.fetch(
          targetUids,
          { uid: true, envelope: true, source: true, internalDate: true },
          { uid: true }
        )) {
          checked += 1;
          if (msg.uid > this.lastSeenUid) {
            this.lastSeenUid = msg.uid;
          }

          const envelopeMsgId = msg.envelope && msg.envelope.messageId
            ? String(msg.envelope.messageId).trim()
            : `imap-uid-${msg.uid}`;

          if (db.hasMessageId(envelopeMsgId)) {
            continue;
          }

          // Filtrado rápido por remitente usando el sobre antes de parsear MIME completo si hay muchos correos
          const envFrom =
            msg.envelope &&
            Array.isArray(msg.envelope.from) &&
            msg.envelope.from[0] &&
            msg.envelope.from[0].address
              ? String(msg.envelope.from[0].address).toLowerCase()
              : '';

          if (envFrom && !parser.isSenderAuthorized(envFrom, officialSenders)) {
            continue;
          }

          const parsed = await simpleParser(msg.source);
          const fromObj =
            parsed.from && Array.isArray(parsed.from.value) && parsed.from.value[0]
              ? parsed.from.value[0]
              : { address: envFrom, name: '' };

          const messageId = (parsed.messageId || envelopeMsgId).trim();
          if (db.hasMessageId(messageId)) {
            continue;
          }

          const analysis = parser.analyzeEmailForPayment({
            fromAddress: fromObj.address,
            fromName: fromObj.name,
            subject: parsed.subject,
            textBody: parsed.text,
            htmlBody: parsed.html,
            date: parsed.date || msg.internalDate || new Date(),
            messageId,
            headers: parsed.headers,
            officialSenders
          });

          if (analysis.accepted) {
            const { inserted, payment } = db.insertPayment(analysis.payment, false);
            if (inserted && payment) {
              added += 1;
              // Anunciar con voz si llegó en vivo, o si fue recibido hace menos de 3 minutos
              const ageMs = Date.now() - new Date(payment.received_at).getTime();
              const shouldSpeak = isLiveEvent || manual || (!isInitialScan) || ageMs < 180000;
              this.emit('payment', { payment, announceVoice: shouldSpeak });
            }
          } else if (analysis.reason !== 'unauthorized_sender') {
            db.logAuditEvent({
              fromEmail: fromObj.address,
              subject: parsed.subject,
              reason: analysis.reason,
              detail: analysis.reasonDetail
            });
            this.emit('audit', {
              fromEmail: fromObj.address,
              subject: parsed.subject,
              reason: analysis.reason,
              detail: analysis.reasonDetail
            });
          }
        }
      }

      this.setStatus({
        state: 'connected',
        lastCheckAt: new Date().toISOString()
      });
    } catch (err) {
      const settings = db.getAllSettings(true);
      const cfg = resolveImapConfig(settings);
      this.setStatus({
        state: 'error',
        message: translateImapError(err, cfg.provider)
      });
    } finally {
      this.scanning = false;
    }

    return { checked, added };
  }
}

module.exports = new EmailWatcher();
