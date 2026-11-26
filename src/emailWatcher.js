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

// Pulso ultrarrápido cada 1.5s (~30 bytes por pulso) para evitar el retraso de 10-15s del IDLE de Gmail
const TURBO_NOOP_INTERVAL_MS = 1500;

function resolveImapConfig(settings) {
  const provider = (settings.email_provider || 'gmail').toLowerCase();
  const preset = PROVIDER_PRESETS[provider];

  const host = preset ? preset.host : (settings.imap_host || '').trim();
  const port = preset ? preset.port : (Number(settings.imap_port) || 993);
  const secure = preset ? preset.secure : settings.imap_tls !== 'false';
  const user = (settings.email_user || '').trim();
  let pass = settings.email_pass || '';

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
    this.noopInFlight = false;
    this.pendingLiveCheck = false;
    this.lastSeenUid = 0;
    this.lastKnownExists = 0;
    this.tickCounter = 0;
    this.reconnectTimer = null;
    this.pollInterval = null;
    this.status = {
      state: 'unconfigured',
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
        error: 'Debes ingresar el correo electrónico y la contraseña de aplicación.'
      };
    }

    const testClient = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      disableAutoIdle: true,
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
    this.pendingLiveCheck = false;
    this.noopInFlight = false;
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
    this.lastKnownExists = 0;
    this.tickCounter = 0;
    await this._connectLoop(cfg, settings);
  }

  async _connectLoop(cfg, settings) {
    if (!this.running) return;

    this.setStatus({
      state: 'connecting',
      message: `Conectando a ${cfg.user} (${cfg.host})...`
    });

    // disableAutoIdle=true evita perder viajes de red saliendo y entrando de IDLE;
    // nuestro pulso NOOP cada 1.5s fuerza a Gmail/Hotmail a entregar nuevos mensajes al instante
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 18000,
      greetingTimeout: 12000
    });

    this.client = client;

    client.on('error', (err) => {
      if (!this.running || this.client !== client) return;
      this.setStatus({
        state: 'error',
        message: translateImapError(err, cfg.provider)
      });
      this._scheduleReconnect(4000);
    });

    client.on('close', () => {
      if (!this.running || this.client !== client) return;
      this.setStatus({
        state: 'connecting',
        message: 'Reconectando canal ultrarrápido de correo...'
      });
      this._scheduleReconnect(2000);
    });

    client.on('exists', (data) => {
      if (!this.running || this.client !== client) return;
      const newCount = data && typeof data.count === 'number' ? data.count : 0;
      const prevCount = data && typeof data.prevCount === 'number' ? data.prevCount : this.lastKnownExists;
      this.lastKnownExists = newCount;
      const delta = Math.max(1, newCount - prevCount);
      this.checkNow({ isLiveEvent: true, expectedNewCount: delta }).catch(() => {});
    });

    try {
      await client.connect();
      if (client.socket && typeof client.socket.setNoDelay === 'function') {
        client.socket.setNoDelay(true);
      }

      const mailbox = await client.mailboxOpen('INBOX');
      this.lastKnownExists = mailbox.exists || 0;

      const lookback = settings.sync_lookback || 'today';
      if (lookback === 'now' && mailbox.uidNext) {
        this.lastSeenUid = Math.max(0, mailbox.uidNext - 1);
      }

      this.setStatus({
        state: 'connected',
        message: `Monitoreo Turbo activo en ${cfg.user} (revisión cada 1.5 s)`,
        lastCheckAt: new Date().toISOString()
      });

      await this.checkNow({ isInitialScan: true });

      if (client.mailbox && client.mailbox.uidNext) {
        this.lastSeenUid = Math.max(this.lastSeenUid, client.mailbox.uidNext - 1);
      }

      // Bucle Turbo NOOP cada 1.5 segundos (solo ~30 bytes por pulso cuando no hay correo nuevo)
      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        this._turboPulse(client);
      }, TURBO_NOOP_INTERVAL_MS);
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

      const isAuthErr = friendly.includes('rechazó');
      if (!isAuthErr && this.running) {
        this._scheduleReconnect(6000);
      }
    }
  }

  async _turboPulse(client) {
    if (!this.running || this.client !== client || !client.usable) return;
    if (this.scanning || this.noopInFlight) return;

    this.noopInFlight = true;
    this.tickCounter += 1;

    try {
      // NOOP obliga a Gmail/Outlook a notificar nuevos mensajes en ~15-30ms sin esperar el batching de IDLE
      await client.noop();

      const currentExists = (client.mailbox && client.mailbox.exists) || 0;
      const countIncreased = currentExists > this.lastKnownExists;
      this.lastKnownExists = currentExists;

      // Si creció el conteo (y 'exists' aún no disparó escaneo) o cada 2 pulsos (3s) verificar rango de UIDs nuevos
      if ((countIncreased || this.tickCounter % 2 === 0) && !this.scanning) {
        await this.checkNow({
          isLiveEvent: true,
          expectedNewCount: countIncreased ? 1 : 0
        });
      }
    } catch (_) {
      // Si el socket cayó silenciosamente, el evento error/close reconectará
    } finally {
      this.noopInFlight = false;
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

  async _processFetchedMessage(msg, { officialSenders, isLiveEvent, manual, isInitialScan }) {
    const envelopeMsgId =
      msg.envelope && msg.envelope.messageId
        ? String(msg.envelope.messageId).trim()
        : `imap-uid-${msg.uid}`;

    if (db.hasMessageId(envelopeMsgId)) return 0;

    const envFrom =
      msg.envelope &&
      Array.isArray(msg.envelope.from) &&
      msg.envelope.from[0] &&
      msg.envelope.from[0].address
        ? String(msg.envelope.from[0].address).toLowerCase()
        : '';

    if (envFrom && !parser.isSenderAuthorized(envFrom, officialSenders)) {
      return 0;
    }

    const parsed = await simpleParser(msg.source);
    const fromObj =
      parsed.from && Array.isArray(parsed.from.value) && parsed.from.value[0]
        ? parsed.from.value[0]
        : { address: envFrom, name: '' };

    const messageId = (parsed.messageId || envelopeMsgId).trim();
    if (db.hasMessageId(messageId)) return 0;

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
        const ageMs = Date.now() - new Date(payment.received_at).getTime();
        const shouldSpeak = isLiveEvent || manual || (!isInitialScan && ageMs < 180000) || ageMs < 90000;
        this.emit('payment', { payment, announceVoice: shouldSpeak });
        return 1;
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
    return 0;
  }

  async checkNow({
    isInitialScan = false,
    isLiveEvent = false,
    manual = false,
    expectedNewCount = 0
  } = {}) {
    if (!this.client || !this.client.usable) {
      if (manual) {
        await this.restart();
      }
      return { checked: 0, added: 0 };
    }

    if (this.scanning) {
      if (isLiveEvent || manual) {
        this.pendingLiveCheck = true;
      }
      return { checked: 0, added: 0, busy: true };
    }

    this.scanning = true;
    let checked = 0;
    let added = 0;

    try {
      const settings = db.getAllSettings(false);
      const officialSenders = parser.normalizeSenderList(settings.official_senders);
      const lookback = settings.sync_lookback || 'today';

      if (this.lastSeenUid > 0 && !manual) {
        // Rango superior explícito 4294967295 (RFC 3501): devuelve 0 mensajes instantáneamente si no hay UID > lastSeenUid,
        // y si llegó correo nuevo lo trae de inmediato sin depender del viejo mailbox.uidNext
        const uidRange = `${this.lastSeenUid + 1}:4294967295`;

        if (expectedNewCount > 0 && expectedNewCount <= 3) {
          // VÍA EXPRÉS EN 1 SOLO VIAJE DE RED: traer sobre + cuerpo directamente
          for await (const msg of this.client.fetch(
            uidRange,
            { uid: true, envelope: true, source: true, internalDate: true },
            { uid: true }
          )) {
            if (msg.uid <= this.lastSeenUid) continue;
            this.lastSeenUid = Math.max(this.lastSeenUid, msg.uid);
            checked += 1;
            added += await this._processFetchedMessage(msg, {
              officialSenders,
              isLiveEvent,
              manual,
              isInitialScan
            });
          }
        } else {
          // Chequeo silencioso de respaldo: traer solo sobres livianos primero
          const candidateUids = [];
          for await (const envMsg of this.client.fetch(
            uidRange,
            { uid: true, envelope: true },
            { uid: true }
          )) {
            if (envMsg.uid <= this.lastSeenUid) continue;
            this.lastSeenUid = Math.max(this.lastSeenUid, envMsg.uid);
            checked += 1;

            const envMsgId =
              envMsg.envelope && envMsg.envelope.messageId
                ? String(envMsg.envelope.messageId).trim()
                : `imap-uid-${envMsg.uid}`;
            if (db.hasMessageId(envMsgId)) continue;

            const envFrom =
              envMsg.envelope &&
              Array.isArray(envMsg.envelope.from) &&
              envMsg.envelope.from[0] &&
              envMsg.envelope.from[0].address
                ? String(envMsg.envelope.from[0].address).toLowerCase()
                : '';

            if (envFrom && !parser.isSenderAuthorized(envFrom, officialSenders)) continue;
            candidateUids.push(envMsg.uid);
          }

          if (candidateUids.length > 0) {
            for await (const msg of this.client.fetch(
              candidateUids,
              { uid: true, envelope: true, source: true, internalDate: true },
              { uid: true }
            )) {
              added += await this._processFetchedMessage(msg, {
                officialSenders,
                isLiveEvent,
                manual,
                isInitialScan
              });
            }
          }
        }
      } else {
        // Escaneo inicial o manual: recuperar también pagos recientes del remitente oficial (hasta 30 días)
        // para que nunca se pierda historial aunque el servidor en la nube se haya reiniciado
        const sinceDate = new Date();
        if (isInitialScan) {
          sinceDate.setDate(sinceDate.getDate() - 30);
          sinceDate.setHours(0, 0, 0, 0);
        } else if (lookback === '7days') {
          sinceDate.setDate(sinceDate.getDate() - 7);
          sinceDate.setHours(0, 0, 0, 0);
        } else {
          sinceDate.setHours(0, 0, 0, 0);
        }

        let recentSlice = [];
        const cleanSenders = officialSenders.filter((s) => !s.startsWith('*'));

        if (isInitialScan && cleanSenders.length > 0 && cleanSenders.length <= 6) {
          const uidSet = new Set();
          for (const sender of cleanSenders) {
            const senderTerm = sender.startsWith('@') ? sender.slice(1) : sender;
            const found = await this.client.search({ since: sinceDate, from: senderTerm }, { uid: true });
            for (const u of found || []) uidSet.add(u);
          }
          recentSlice = Array.from(uidSet).sort((a, b) => a - b).slice(-150);
        } else {
          const searchedUids = await this.client.search({ since: sinceDate }, { uid: true });
          recentSlice = (searchedUids || []).slice(-60);
        }

        if (recentSlice.length > 0) {
          const filtered = [];
          for await (const envMsg of this.client.fetch(
            recentSlice,
            { uid: true, envelope: true },
            { uid: true }
          )) {
            this.lastSeenUid = Math.max(this.lastSeenUid, envMsg.uid);
            checked += 1;

            const envMsgId =
              envMsg.envelope && envMsg.envelope.messageId
                ? String(envMsg.envelope.messageId).trim()
                : `imap-uid-${envMsg.uid}`;
            if (db.hasMessageId(envMsgId)) continue;

            const envFrom =
              envMsg.envelope &&
              Array.isArray(envMsg.envelope.from) &&
              envMsg.envelope.from[0] &&
              envMsg.envelope.from[0].address
                ? String(envMsg.envelope.from[0].address).toLowerCase()
                : '';

            if (envFrom && !parser.isSenderAuthorized(envFrom, officialSenders)) continue;
            filtered.push(envMsg.uid);
          }

          if (filtered.length > 0) {
            for await (const msg of this.client.fetch(
              filtered,
              { uid: true, envelope: true, source: true, internalDate: true },
              { uid: true }
            )) {
              added += await this._processFetchedMessage(msg, {
                officialSenders,
                isLiveEvent,
                manual,
                isInitialScan
              });
            }
          }
        }
      }

      if (checked > 0 || manual || isInitialScan) {
        this.setStatus({
          state: 'connected',
          lastCheckAt: new Date().toISOString()
        });
      }
    } catch (err) {
      const settings = db.getAllSettings(true);
      const cfg = resolveImapConfig(settings);
      this.setStatus({
        state: 'error',
        message: translateImapError(err, cfg.provider)
      });
    } finally {
      this.scanning = false;
      if (this.pendingLiveCheck && this.running) {
        this.pendingLiveCheck = false;
        setImmediate(() => {
          this.checkNow({ isLiveEvent: true, expectedNewCount: 1 }).catch(() => {});
        });
      }
    }

    return { checked, added };
  }
}

module.exports = new EmailWatcher();
