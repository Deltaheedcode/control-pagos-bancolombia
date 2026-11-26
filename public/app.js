(function () {
  const BANCOLOMBIA_OFFICIAL_LIST =
    'alertasynotificaciones@notificacionesbancolombia.com, alertasynotificaciones@bancolombia.com.co, notificaciones@bancolombia.com.co';
  const TEST_SENDER_EMAIL = 'jhocamza@gmail.com';

  const state = {
    authenticated: false,
    role: 'viewer',
    userLabel: '',
    period: 'today',
    customStart: '',
    customEnd: '',
    payments: [],
    totalAmount: 0,
    settings: {},
    watcherStatus: {},
    devices: [],
    voiceEnabled: localStorage.getItem('bancolombia_voice_enabled') !== 'false',
    audioUnlocked: false,
    ws: null,
    wsReconnectTimer: null
  };

  let audioCtx = null;

  // --- SONIDO Y SÍNTESIS DE VOZ EN ESPAÑOL ---
  function unlockAudio() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass && !audioCtx) {
        audioCtx = new AudioContextClass();
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      if ('speechSynthesis' in window) {
        const warm = new SpeechSynthesisUtterance('');
        warm.volume = 0;
        window.speechSynthesis.speak(warm);
      }
      state.audioUnlocked = true;
      const banner = document.getElementById('audioUnlockBanner');
      if (banner) banner.classList.add('hidden');
    } catch (_) {}
  }

  function playCashChime() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioCtx) audioCtx = new AudioContextClass();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const freqs = [1318.5, 1975.5];
      freqs.forEach((f, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now + idx * 0.13);
        gain.gain.setValueAtTime(0.001, now + idx * 0.13);
        gain.gain.exponentialRampToValueAtTime(0.22, now + idx * 0.13 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.13 + 0.35);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + idx * 0.13);
        osc.stop(now + idx * 0.13 + 0.36);
      });
    } catch (_) {}
  }

  function pickSpanishVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const priorities = ['es-co', 'es-mx', 'es-419', 'es-us', 'es-es', 'es'];
    for (const pref of priorities) {
      const found = voices.find((v) => String(v.lang || '').toLowerCase().startsWith(pref));
      if (found) return found;
    }
    return null;
  }

  function speakText(phrase, forceEvenIfDisabled = false) {
    if (!state.voiceEnabled && !forceEvenIfDisabled) return;

    playCashChime();
    if (!('speechSynthesis' in window)) return;

    setTimeout(() => {
      try {
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
        const utter = new SpeechSynthesisUtterance(phrase);
        const voice = pickSpanishVoice();
        if (voice) utter.voice = voice;
        utter.lang = (voice && voice.lang) || 'es-CO';
        utter.rate = 1.02;
        utter.pitch = 1.0;
        utter.volume = 1.0;
        window.speechSynthesis.speak(utter);
      } catch (_) {}
    }, 160);
  }

  // --- GESTIÓN DE VISTAS LOGIN VS DASHBOARD ---
  function showLoginScreen(customMessage = '') {
    state.authenticated = false;
    if (state.wsReconnectTimer) {
      clearTimeout(state.wsReconnectTimer);
      state.wsReconnectTimer = null;
    }
    if (state.ws) {
      try {
        state.ws.close();
      } catch (_) {}
      state.ws = null;
    }
    document.getElementById('appRoot').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginPass').value = '';

    const errEl = document.getElementById('loginError');
    if (customMessage) {
      errEl.textContent = customMessage;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }
  }

  function applyRolePermissions() {
    const isAdmin = state.role === 'admin';
    document.querySelectorAll('[data-admin-only="true"]').forEach((el) => {
      if (isAdmin) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    });

    const roleBadge = document.getElementById('roleBadge');
    if (roleBadge) {
      roleBadge.textContent = isAdmin
        ? `🛡️ ${state.userLabel || 'Administrador'}`
        : `📱 ${state.userLabel || 'Celular'} • Solo Lectura`;
    }

    const senderBadge = document.getElementById('officialSenderBadge');
    if (senderBadge) {
      senderBadge.style.cursor = isAdmin ? 'pointer' : 'default';
      senderBadge.title = isAdmin ? 'Haz clic para cambiar remitente oficial' : '';
    }
  }

  async function showAuthenticatedApp(roleInfo = {}) {
    state.authenticated = true;
    if (roleInfo.role) state.role = roleInfo.role;
    if (roleInfo.label) state.userLabel = roleInfo.label;

    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appRoot').classList.remove('hidden');
    applyRolePermissions();
    renderVoiceControls();
    await loadInitialState();
    await loadPayments(false);
    connectWebSocket();
  }

  // --- API HELPER ---
  async function apiFetch(url, options = {}) {
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      options.headers || {}
    );
    const resp = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin'
    });

    const data = await resp.json().catch(() => ({}));
    if (resp.status === 401 && data && data.authRequired) {
      showLoginScreen(data.sessionReplaced ? data.error : '');
      return null;
    }
    return data;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('es-CO', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      }).format(new Date(iso));
    } catch (_) {
      return iso;
    }
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 15) return 'Hace instantes';
    if (diffSec < 60) return `Hace ${diffSec} seg`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `Hace ${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Hace ${hrs} h`;
    const days = Math.floor(hrs / 24);
    return `Hace ${days} día(s)`;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- RENDERIZADO ---
  function renderVoiceControls() {
    const toggle = document.getElementById('toggleVoice');
    const icon = document.getElementById('voiceIcon');
    const desc = document.getElementById('voiceStatusDesc');
    toggle.checked = state.voiceEnabled;
    icon.textContent = state.voiceEnabled ? '🔊' : '🔇';
    desc.innerHTML = state.voiceEnabled
      ? 'Activa: dirá <em>"Has recibido [monto] pesos"</em> automáticamente'
      : 'Silenciada en este dispositivo (solo alerta visual)';

    const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
    const unlockBanner = document.getElementById('audioUnlockBanner');
    if (isMobile && state.voiceEnabled && !state.audioUnlocked) {
      unlockBanner.classList.remove('hidden');
    } else {
      unlockBanner.classList.add('hidden');
    }
  }

  function renderWatcherStatus(st) {
    if (!st) return;
    state.watcherStatus = st;
    const dot = document.getElementById('watcherDot');
    const text = document.getElementById('watcherText');
    const lastCheck = document.getElementById('lastCheckText');
    const senderBadge = document.getElementById('officialSenderBadge');

    dot.className = `status-dot ${st.state || 'unconfigured'}`;
    text.textContent = st.message || 'Sin estado';

    if (st.lastCheckAt) {
      lastCheck.textContent = `Última verificación: ${formatDateTime(st.lastCheckAt)}`;
    } else {
      lastCheck.textContent = '';
    }

    const senders = st.officialSenders || [];
    if (state.role !== 'admin') {
      senderBadge.textContent = '✔ Verificación Oficial Activa';
      senderBadge.className = 'sender-pill';
      return;
    }
    const label = senders.length > 0 ? senders.join(', ') : 'No definido';
    const isTestSender = senders.some((s) => s.includes('jhocamza@gmail.com'));
    senderBadge.textContent = isTestSender
      ? `Remitente autorizado (Prueba): ${label}`
      : `Remitente oficial: ${label}`;
    senderBadge.className = isTestSender ? 'sender-pill test-mode' : 'sender-pill';
  }

  function renderDevices(devices) {
    state.devices = devices || [];
    document.getElementById('deviceCount').textContent = String(state.devices.length || 1);
    const listEl = document.getElementById('connectedDevicesList');
    if (!listEl) return;

    if (state.devices.length === 0) {
      listEl.innerHTML = '<div class="device-item">Ningún dispositivo reportado</div>';
      return;
    }

    listEl.innerHTML = state.devices
      .map((d) => {
        const icon = d.deviceType === 'phone' ? '📱' : '💻';
        const voiceTxt = d.voiceEnabled ? '🔊 Voz activa' : '🔇 Silenciado';
        return `
          <div class="device-item">
            <span><strong>${icon} ${escapeHtml(d.name)}</strong></span>
            <span style="color: #059669; font-weight: 600;">${voiceTxt}</span>
          </div>
        `;
      })
      .join('');
  }

  function renderPayments(data, flashLatest = false) {
    const payments = data.payments || [];
    state.payments = payments;
    state.totalAmount = data.total_amount || 0;

    document.getElementById('summaryPeriodLabel').textContent =
      `TOTAL RECIBIDO (${(data.periodLabel || 'HOY').toUpperCase()})`;
    document.getElementById('heroTotalAmount').textContent =
      data.formatted_total || NumberToSpanish.formatCOP(0);
    document.getElementById('heroCount').textContent = String(payments.length);

    document.getElementById('bottomTotalAmount').textContent =
      data.formatted_total || NumberToSpanish.formatCOP(0);
    document.getElementById('bottomCountText').textContent =
      `${payments.length} pago(s) verificado(s) en ${data.periodLabel || 'el periodo'}`;

    const latestCard = document.getElementById('latestCard');
    const latestBadge = document.getElementById('latestBadge');
    const latestTimeAgo = document.getElementById('latestTimeAgo');
    const latestContent = document.getElementById('latestContent');
    const latestMeta = document.getElementById('latestMeta');

    if (payments.length > 0) {
      const latest = payments[0];
      latestCard.classList.add('has-payment');
      if (flashLatest) {
        latestCard.classList.remove('flash-alert');
        void latestCard.offsetWidth;
        latestCard.classList.add('flash-alert');
      }

      latestBadge.innerHTML = latest.is_test
        ? '✔ PAGO DE PRUEBA VERIFICADO'
        : '✔ PAGO OFICIAL VERIFICADO';
      latestTimeAgo.textContent = timeAgo(latest.received_at);
      latestTimeAgo.dataset.iso = latest.received_at;

      latestContent.innerHTML = `
        <div class="latest-amount">${escapeHtml(latest.formatted_amount)}</div>
        <div style="font-size: 0.92rem; color: #065f46; font-weight: 600;">
          "${escapeHtml(latest.voice_phrase)}"
        </div>
      `;

      latestMeta.classList.remove('hidden');
      latestMeta.innerHTML = `
        <span><strong>Canal:</strong> ${escapeHtml(latest.channel || 'Bancolombia')}</span>
        ${latest.payer ? `<span><strong>De:</strong> ${escapeHtml(latest.payer)}</span>` : ''}
        <span><strong>Correo verificado:</strong> ${escapeHtml(latest.sender_email)}</span>
        <span><strong>Hora:</strong> ${escapeHtml(formatDateTime(latest.received_at))}</span>
      `;
    } else {
      latestCard.classList.remove('has-payment', 'flash-alert');
      latestBadge.textContent = '⏳ Esperando pagos verificados';
      latestTimeAgo.textContent = '';
      latestTimeAgo.dataset.iso = '';
      latestContent.innerHTML = `
        <div class="latest-empty">
          No hay pagos registrados en <strong>${escapeHtml(data.periodLabel || 'este periodo')}</strong>.<br/>
          Cuando llegue un correo del remitente autorizado, aparecerá aquí al instante y sonará la voz.
        </div>
      `;
      latestMeta.classList.add('hidden');
    }

    const tbody = document.getElementById('paymentsTableBody');
    if (payments.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: #64748b; padding: 26px;">
            Sin pagos registrados para este filtro.
          </td>
        </tr>
      `;
      return;
    }

    const isAdmin = state.role === 'admin';
    tbody.innerHTML = payments
      .map((p) => {
        const testTag = p.is_test ? '<span class="tag-test">PRUEBA</span>' : '';
        const subInfo = p.payer
          ? `De: ${escapeHtml(p.payer)}`
          : escapeHtml((p.subject || '').slice(0, 55));
        const deleteBtnHtml = isAdmin
          ? `<button class="btn btn-danger-ghost btn-delete" data-id="${p.id}" title="Eliminar registro">✕</button>`
          : '';
        return `
          <tr>
            <td style="white-space: nowrap; font-size: 0.83rem;">${escapeHtml(formatDateTime(p.received_at))}</td>
            <td>
              <div style="font-weight: 700;">${escapeHtml(p.channel || 'Pago')}${testTag}</div>
              <div style="font-size: 0.8rem; color: #64748b;">${subInfo}</div>
            </td>
            <td style="font-size: 0.83rem;">
              <span style="color: #059669; font-weight: 700;">✔</span> ${escapeHtml(p.sender_email)}
            </td>
            <td style="font-size: 0.82rem; color: #475569;">${escapeHtml(p.reference || '—')}</td>
            <td class="amount-cell" style="text-align: right;">${escapeHtml(p.formatted_amount)}</td>
            <td style="text-align: center; white-space: nowrap;">
              <button class="btn btn-outline btn-sm btn-replay" data-phrase="${escapeHtml(p.voice_phrase)}" title="Repetir lectura en voz alta">
                🔊
              </button>
              ${deleteBtnHtml}
            </td>
          </tr>
        `;
      })
      .join('');
  }

  const VAULT_STORAGE_KEY = 'bcol_encrypted_vault_v1';

  async function loadInitialState() {
    let res = await apiFetch('/api/state');
    if (!res || !res.ok) return;

    if (res.role) state.role = res.role;
    if (res.userLabel) state.userLabel = res.userLabel;
    applyRolePermissions();

    // Sincronizar/restaurar siempre desde la bóveda sellada AES-256-GCM (idempotente) para que ni claves ni pagos se pierdan
    const savedVault = localStorage.getItem(VAULT_STORAGE_KEY);
    if (savedVault) {
      const restored = await apiFetch('/api/settings/restore-vault', {
        method: 'POST',
        body: JSON.stringify({ encryptedVault: savedVault })
      });
      if (restored && restored.ok && restored.restored) {
        res = {
          ...res,
          settings: restored.settings,
          encryptedVault: restored.encryptedVault,
          watcherStatus: restored.watcherStatus
        };
      }
    }

    if (res.encryptedVault) {
      localStorage.setItem(VAULT_STORAGE_KEY, res.encryptedVault);
    }

    state.settings = res.settings || {};
    document.getElementById('businessTitle').textContent =
      state.settings.business_name || 'Control de Pagos Bancolombia';
    renderWatcherStatus(res.watcherStatus);
    renderDevices(res.devices);
  }

  function buildPeriodQueryString() {
    const params = new URLSearchParams({ period: state.period });
    if (state.period === 'custom') {
      if (state.customStart) params.set('start', state.customStart);
      if (state.customEnd) params.set('end', state.customEnd);
    }
    return params.toString();
  }

  async function loadPayments(flashLatest = false) {
    if (!state.authenticated) return;
    const qs = buildPeriodQueryString();
    const res = await apiFetch(`/api/payments?${qs}`);
    if (res && res.ok) {
      renderPayments(res, flashLatest);
    }
  }

  // --- WEBSOCKET TIEMPO REAL (AUTENTICADO POR COOKIE HTTPONLY) ---
  function connectWebSocket() {
    if (!state.authenticated) return;
    if (state.ws) {
      try {
        state.ws.close();
      } catch (_) {}
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          voiceEnabled: state.voiceEnabled
        })
      );
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'session_replaced') {
          showLoginScreen(
            msg.message ||
              '🔒 Tu sesión se cerró porque este usuario inició sesión en otro navegador o dispositivo.'
          );
          return;
        }
        if (msg.type === 'new_payment' && msg.payment) {
          if (msg.encryptedVault) {
            localStorage.setItem(VAULT_STORAGE_KEY, msg.encryptedVault);
          }
          if (msg.announceVoice) {
            speakText(msg.payment.voice_phrase, false);
          }
          // Renderizado instantáneo en 0ms sin esperar consulta HTTP adicional
          if (state.period === 'today' || state.period === '7days' || state.period === 'month' || state.period === 'all') {
            const exists = state.payments.some((p) => p.id === msg.payment.id);
            if (!exists) {
              const updatedList = [msg.payment, ...state.payments];
              const newTotal = updatedList.reduce((acc, p) => acc + Number(p.amount || 0), 0);
              renderPayments(
                {
                  periodLabel: state.period === 'today' ? 'Hoy' : 'Periodo actual',
                  payments: updatedList,
                  total_amount: newTotal,
                  formatted_total: NumberToSpanish.formatCOP(newTotal)
                },
                true
              );
            }
          }
          loadPayments(false);
        } else if (msg.type === 'payments_changed') {
          if (msg.encryptedVault) {
            localStorage.setItem(VAULT_STORAGE_KEY, msg.encryptedVault);
          }
          loadPayments(false);
        } else if (msg.type === 'watcher_status') {
          renderWatcherStatus(msg.status);
        } else if (msg.type === 'devices') {
          renderDevices(msg.devices);
        } else if (msg.type === 'settings_updated') {
          if (msg.encryptedVault) {
            localStorage.setItem(VAULT_STORAGE_KEY, msg.encryptedVault);
          }
          if (msg.settings) {
            state.settings = msg.settings;
            document.getElementById('businessTitle').textContent =
              state.settings.business_name || 'Control de Pagos Bancolombia';
          }
          if (msg.watcherStatus) renderWatcherStatus(msg.watcherStatus);
        }
      } catch (_) {}
    });

    ws.addEventListener('close', (ev) => {
      if (ev.code === 4002) {
        showLoginScreen(
          '🔒 Tu sesión se cerró porque este usuario inició sesión en otro navegador o dispositivo.'
        );
        return;
      }
      if (ev.code === 4003) {
        showLoginScreen(
          '🔒 Tu sesión se trasladó a una pestaña más reciente en este dispositivo.'
        );
        return;
      }
      if (ev.code === 4001) {
        showLoginScreen();
        return;
      }
      if (state.authenticated) {
        state.wsReconnectTimer = setTimeout(connectWebSocket, 3500);
      }
    });
  }

  // --- MODALES ---
  function openSettingsModal() {
    if (state.role !== 'admin') return;
    const s = state.settings || {};
    document.getElementById('cfgBusinessName').value = s.business_name || 'Control de Pagos Bancolombia';
    document.getElementById('cfgProvider').value = s.email_provider || 'gmail';
    document.getElementById('cfgImapHost').value = s.imap_host || '';
    document.getElementById('cfgImapPort').value = s.imap_port || '993';
    document.getElementById('cfgEmailUser').value = s.email_user || '';
    // Jamás se rellena ni expone la clave de aplicación
    document.getElementById('cfgEmailPass').value = '';
    document.getElementById('passSavedHint').textContent = s.has_password
      ? '🔒 Bóveda cifrada AES-256-GCM activa: tu clave permanece oculta y se restaura automáticamente aunque Render entre en reposo.'
      : 'Ingresa tu clave una vez; quedará respaldada con cifrado AES-256-GCM aunque Render entre en reposo.';
    document.getElementById('cfgOfficialSenders').value = s.official_senders || TEST_SENDER_EMAIL;
    document.getElementById('cfgLookback').value = s.sync_lookback || 'today';
    document.getElementById('settingsFeedback').classList.add('hidden');

    toggleCustomImapVisibility();
    document.getElementById('modalSettings').classList.remove('hidden');
  }

  function toggleCustomImapVisibility() {
    const prov = document.getElementById('cfgProvider').value;
    const wrap = document.getElementById('customImapFields');
    if (prov === 'custom') {
      wrap.classList.remove('hidden');
    } else {
      wrap.classList.add('hidden');
    }
  }

  function collectSettingsForm(clearInputAfterRead = false) {
    const s = state.settings || {};
    const passEl = document.getElementById('cfgEmailPass');
    const passInput = passEl.value.trim();
    if (clearInputAfterRead) {
      passEl.value = '';
    }

    return {
      business_name: document.getElementById('cfgBusinessName').value.trim() || 'Control de Pagos Bancolombia',
      email_provider: document.getElementById('cfgProvider').value,
      imap_host: document.getElementById('cfgImapHost').value.trim(),
      imap_port: document.getElementById('cfgImapPort').value.trim() || '993',
      imap_tls: 'true',
      email_user: document.getElementById('cfgEmailUser').value.trim(),
      email_pass: passInput ? passInput : s.has_password ? '__KEEP__' : '',
      official_senders: document.getElementById('cfgOfficialSenders').value.trim(),
      sync_lookback: document.getElementById('cfgLookback').value
    };
  }

  async function openPhonesModal(selectedIp = '') {
    if (state.role !== 'admin') return;
    document.getElementById('modalPhones').classList.remove('hidden');
    const url = selectedIp
      ? `/api/network-info?ip=${encodeURIComponent(selectedIp)}`
      : '/api/network-info';
    const res = await apiFetch(url);
    if (!res || !res.ok) return;

    document.getElementById('qrImage').src = res.qrDataUrl;
    document.getElementById('lanUrlText').textContent = res.primaryUrl;
    renderDevices(res.devices);

    const selectWrap = document.getElementById('networkSelectWrap');
    const selectEl = document.getElementById('networkIpSelect');
    if (res.addresses && res.addresses.length > 1) {
      selectWrap.classList.remove('hidden');
      selectEl.innerHTML = res.addresses
        .map(
          (a) =>
            `<option value="${escapeHtml(a.ip)}" ${a.ip === res.primaryIp ? 'selected' : ''}>
              ${escapeHtml(a.interface)} — ${escapeHtml(a.url)}
            </option>`
        )
        .join('');
    } else {
      selectWrap.classList.add('hidden');
    }
  }

  function downloadPdfReport() {
    if (state.role !== 'admin') return;
    const qs = buildPeriodQueryString();
    window.location.href = `/api/report/pdf?${qs}`;
  }

  // --- INICIALIZACIÓN ---
  document.addEventListener('DOMContentLoaded', async () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }

    document.getElementById('audioUnlockBanner').addEventListener('click', () => {
      unlockAudio();
      speakText('Altavoz activado', true);
    });

    // Formulario de Inicio de Sesión
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      unlockAudio();

      const userEl = document.getElementById('loginUser');
      const passEl = document.getElementById('loginPass');
      const errEl = document.getElementById('loginError');
      const submitBtn = document.getElementById('btnLoginSubmit');

      const username = userEl.value.trim();
      const password = passEl.value;
      // Borrar inmediatamente la contraseña del DOM
      passEl.value = '';

      errEl.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Verificando credenciales...';

      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ username, password })
        });
        const data = await resp.json().catch(() => ({}));

        if (resp.ok && data.ok) {
          userEl.value = '';
          await showAuthenticatedApp({ role: data.role, label: data.label });
        } else {
          errEl.textContent = data.error || 'Credenciales inválidas.';
          errEl.classList.remove('hidden');
        }
      } catch (_) {
        errEl.textContent = 'Error de conexión con el servidor.';
        errEl.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '🔒 Iniciar Sesión Segura';
      }
    });

    // Botón Cerrar Sesión
    document.getElementById('btnLogout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin'
      }).catch(() => {});
      showLoginScreen();
    });

    // Switch de Voz
    document.getElementById('toggleVoice').addEventListener('change', (e) => {
      unlockAudio();
      state.voiceEnabled = e.target.checked;
      localStorage.setItem('bancolombia_voice_enabled', String(state.voiceEnabled));
      renderVoiceControls();
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(
          JSON.stringify({
            type: 'update_device',
            voiceEnabled: state.voiceEnabled
          })
        );
      }
      if (state.voiceEnabled) {
        speakText('Lectura en voz alta activada', true);
      }
    });

    document.getElementById('btnTestVoice').addEventListener('click', () => {
      unlockAudio();
      const samplePhrase = NumberToSpanish.paymentVoicePhrase(50000);
      speakText(samplePhrase, true);
    });

    document.getElementById('btnOpenSettings').addEventListener('click', openSettingsModal);
    document.getElementById('officialSenderBadge').addEventListener('click', openSettingsModal);
    document.getElementById('btnOpenPhones').addEventListener('click', () => openPhonesModal());
    document.getElementById('btnOpenSimulate').addEventListener('click', () => {
      document.getElementById('modalSimulate').classList.remove('hidden');
    });

    document.getElementById('btnCheckNow').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.textContent = '⏳ Revisando...';
      btn.disabled = true;
      try {
        await apiFetch('/api/email/check-now', { method: 'POST' });
        await loadPayments(false);
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });

    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.close).classList.add('hidden');
      });
    });

    document.getElementById('networkIpSelect').addEventListener('change', (e) => {
      openPhonesModal(e.target.value);
    });

    document.getElementById('btnCopyUrl').addEventListener('click', async () => {
      const url = document.getElementById('lanUrlText').textContent.trim();
      try {
        await navigator.clipboard.writeText(url);
        document.getElementById('btnCopyUrl').textContent = '✔ Enlace copiado';
        setTimeout(() => {
          document.getElementById('btnCopyUrl').textContent = '📋 Copiar enlace';
        }, 2000);
      } catch (_) {}
    });

    document.getElementById('cfgProvider').addEventListener('change', toggleCustomImapVisibility);
    document.getElementById('btnPresetTest').addEventListener('click', () => {
      document.getElementById('cfgOfficialSenders').value = TEST_SENDER_EMAIL;
    });
    document.getElementById('btnPresetBank').addEventListener('click', () => {
      document.getElementById('cfgOfficialSenders').value = BANCOLOMBIA_OFFICIAL_LIST;
    });
    document.getElementById('btnPresetBoth').addEventListener('click', () => {
      document.getElementById('cfgOfficialSenders').value = `${TEST_SENDER_EMAIL}, ${BANCOLOMBIA_OFFICIAL_LIST}`;
    });

    document.getElementById('btnTestImap').addEventListener('click', async () => {
      const feedback = document.getElementById('settingsFeedback');
      feedback.className = 'alert-msg';
      feedback.textContent = '⏳ Probando conexión con el servidor de correo...';
      feedback.classList.remove('hidden');

      const payload = collectSettingsForm(false);
      const res = await apiFetch('/api/email/test-connection', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (res && res.ok) {
        feedback.className = 'alert-msg ok';
        feedback.textContent = `✔ ${res.message}`;
      } else if (res) {
        feedback.className = 'alert-msg err';
        feedback.textContent = `✕ ${res.error || 'No fue posible conectar'}`;
      }
    });

    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      // Limpia inmediatamente el input tras leerlo para no dejarlo en el DOM
      const payload = collectSettingsForm(true);
      const feedback = document.getElementById('settingsFeedback');
      feedback.className = 'alert-msg';
      feedback.textContent = '⏳ Cifrando y guardando cambios...';
      feedback.classList.remove('hidden');

      const res = await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (res && res.ok) {
        if (res.encryptedVault) {
          localStorage.setItem(VAULT_STORAGE_KEY, res.encryptedVault);
        }
        state.settings = res.settings;
        renderWatcherStatus(res.watcherStatus);
        document.getElementById('businessTitle').textContent =
          state.settings.business_name || 'Control de Pagos Bancolombia';
        document.getElementById('modalSettings').classList.add('hidden');
      } else if (res) {
        feedback.className = 'alert-msg err';
        feedback.textContent = 'Error guardando la configuración.';
      }
    });

    document.getElementById('simulateForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      unlockAudio();
      const amount = Number(document.getElementById('simAmount').value) || 50000;
      const channel = document.getElementById('simChannel').value;
      const payer = document.getElementById('simPayer').value.trim();

      const res = await apiFetch('/api/payments/simulate', {
        method: 'POST',
        body: JSON.stringify({ amount, channel, payer })
      });

      if (res && res.ok) {
        document.getElementById('modalSimulate').classList.add('hidden');
      } else if (res && res.error) {
        window.alert(res.error);
      }
    });

    document.getElementById('btnClearSimulated').addEventListener('click', async () => {
      await apiFetch('/api/payments-test', { method: 'DELETE' });
      document.getElementById('modalSimulate').classList.add('hidden');
      await loadPayments(false);
    });

    document.querySelectorAll('#periodTabs .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#periodTabs .tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.period = btn.dataset.period;

        const customBar = document.getElementById('customDateBar');
        if (state.period === 'custom') {
          customBar.classList.remove('hidden');
        } else {
          customBar.classList.add('hidden');
          loadPayments(false);
        }
      });
    });

    document.getElementById('btnApplyDates').addEventListener('click', () => {
      state.customStart = document.getElementById('dateStart').value;
      state.customEnd = document.getElementById('dateEnd').value;
      loadPayments(false);
    });

    document.getElementById('btnDownloadPdfTop').addEventListener('click', downloadPdfReport);
    document.getElementById('btnDownloadPdfBottom').addEventListener('click', downloadPdfReport);

    document.getElementById('paymentsTableBody').addEventListener('click', async (e) => {
      const replayBtn = e.target.closest('.btn-replay');
      if (replayBtn) {
        unlockAudio();
        speakText(replayBtn.dataset.phrase, true);
        return;
      }

      const delBtn = e.target.closest('.btn-delete');
      if (delBtn) {
        const id = delBtn.dataset.id;
        if (window.confirm('¿Deseas eliminar este registro de pago?')) {
          await apiFetch(`/api/payments/${id}`, { method: 'DELETE' });
          await loadPayments(false);
        }
      }
    });

    setInterval(() => {
      const el = document.getElementById('latestTimeAgo');
      if (el && el.dataset.iso) {
        el.textContent = timeAgo(el.dataset.iso);
      }
    }, 15000);

    // Keep-alive HTTP cada 8 minutos mientras esté abierto para evitar que Render entre en reposo
    setInterval(() => {
      if (state.authenticated) {
        fetch('/api/health', { cache: 'no-store' }).catch(() => {});
        const savedVault = localStorage.getItem(VAULT_STORAGE_KEY);
        if (savedVault && state.watcherStatus && state.watcherStatus.state === 'unconfigured') {
          apiFetch('/api/settings/restore-vault', {
            method: 'POST',
            body: JSON.stringify({ encryptedVault: savedVault })
          }).catch(() => {});
        }
      }
    }, 4 * 60 * 1000);

    // Si viene desde escaneo de código QR (?login=1), limpiar cualquier cookie previa en ese teléfono y exigir login obligatorio
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('login') === '1') {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin'
      }).catch(() => {});
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, '', window.location.pathname || '/');
      }
      showLoginScreen();
      return;
    }

    // Verificar si ya existe cookie de sesión activa al cargar la página
    try {
      const sessionResp = await fetch('/api/auth/session', {
        credentials: 'same-origin'
      }).then((r) => r.json());

      if (sessionResp && sessionResp.authenticated) {
        await showAuthenticatedApp({ role: sessionResp.role, label: sessionResp.label });
      } else {
        showLoginScreen();
      }
    } catch (_) {
      showLoginScreen();
    }
  });
})();
