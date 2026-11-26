const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { WebSocket } = require('ws');

const NumberToSpanish = require('../public/numberToSpanish');
const parser = require('../src/parser');
const security = require('../src/security');
const db = require('../src/db');
const { createAppServer } = require('../server');

test('Conversión exacta de montos COP a voz en español', () => {
  assert.equal(
    NumberToSpanish.paymentVoicePhrase(50000),
    'Has recibido cincuenta mil pesos'
  );
  assert.equal(
    NumberToSpanish.paymentVoicePhrase(1000),
    'Has recibido mil pesos'
  );
  assert.equal(
    NumberToSpanish.paymentVoicePhrase(21500),
    'Has recibido veintiún mil quinientos pesos'
  );
  assert.equal(
    NumberToSpanish.paymentVoicePhrase(100000),
    'Has recibido cien mil pesos'
  );
  assert.equal(
    NumberToSpanish.paymentVoicePhrase(135800),
    'Has recibido ciento treinta y cinco mil ochocientos pesos'
  );
  assert.equal(
    NumberToSpanish.paymentVoicePhrase(1000000),
    'Has recibido un millón de pesos'
  );
  assert.equal(
    NumberToSpanish.paymentVoicePhrase(1250000),
    'Has recibido un millón doscientos cincuenta mil pesos'
  );
});

test('Parseo de formatos numéricos colombianos y de Bancolombia', () => {
  assert.equal(parser.parseColombianAmountString('50.000'), 50000);
  assert.equal(parser.parseColombianAmountString('50.000,00'), 50000);
  assert.equal(parser.parseColombianAmountString('50,000.00'), 50000);
  assert.equal(parser.parseColombianAmountString('1.250.000'), 1250000);
  assert.equal(parser.parseColombianAmountString('1,250,000.00'), 1250000);
  assert.equal(parser.parseColombianAmountString('85000'), 85000);
});

test('Bóveda AES-256-GCM cifra clave de aplicación y detecta manipulación', () => {
  const sampleAppPass = 'wxyz abcd mnop qrst';
  const encrypted = security.encryptSecret(sampleAppPass);

  assert.equal(security.isEncryptedSecret(encrypted), true);
  assert.equal(encrypted.includes('wxyz'), false);
  assert.equal(security.decryptSecret(encrypted), sampleAppPass);

  // Manipular 1 carácter del texto cifrado debe invalidar la etiqueta GCM
  const tampered = encrypted.slice(0, -2) + (encrypted.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(security.decryptSecret(tampered), '');
});

test('Filtro anti-fraude: acepta remitente oficial, rechaza falsos, spoofing y compras salientes', () => {
  const okTest = parser.analyzeEmailForPayment({
    fromAddress: 'jhocamza@gmail.com',
    fromName: 'Jhoan',
    subject: 'Pago recibido',
    textBody: 'Hola, recibiste una transferencia por $75.000 en tu cuenta.',
    htmlBody: '',
    officialSenders: 'jhocamza@gmail.com'
  });
  assert.equal(okTest.accepted, true);
  assert.equal(okTest.payment.amount, 75000);

  const fakeSender = parser.analyzeEmailForPayment({
    fromAddress: 'bancolombia.falso123@gmail.com',
    fromName: 'Bancolombia',
    subject: 'Bancolombia le informa recepción transferencia',
    textBody: 'Recibiste una transferencia por $200.000,00',
    htmlBody: '',
    officialSenders: 'jhocamza@gmail.com'
  });
  assert.equal(fakeSender.accepted, false);
  assert.equal(fakeSender.reason, 'unauthorized_sender');

  const spoofed = parser.analyzeEmailForPayment({
    fromAddress: 'alertasynotificaciones@notificacionesbancolombia.com',
    fromName: 'Bancolombia',
    subject: 'Recepción transferencia',
    textBody: 'Recibiste $120.000,00',
    headers: new Map([['authentication-results', 'mx.google.com; spf=fail; dkim=fail; dmarc=fail']]),
    officialSenders: parser.DEFAULT_BANCOLOMBIA_SENDERS
  });
  assert.equal(spoofed.accepted, false);
  assert.equal(spoofed.reason, 'spoof_suspected');

  const outgoing = parser.analyzeEmailForPayment({
    fromAddress: 'alertasynotificaciones@notificacionesbancolombia.com',
    fromName: 'Bancolombia',
    subject: 'Alerta Bancolombia',
    textBody: 'Bancolombia le informa Compra por $42.000,00 en EXITO con tu T.Debito *1234.',
    officialSenders: parser.DEFAULT_BANCOLOMBIA_SENDERS
  });
  assert.equal(outgoing.accepted, false);
  assert.equal(outgoing.reason, 'outgoing_transaction');
});

test('Seguridad E2E: roles Admin + 2 Celulares (viewer), bloqueo 403, cifrado AES-256-GCM y persistencia', async () => {
  // Cuentas efímeras generadas solo en memoria para el test (1 Admin + 2 Celulares solo lectura)
  const ephemeralAccounts = [
    security.generateCredentialsConfig('ADMIN_TEST', 'ClaveEfimeraAdmin#99', 'admin', 'Administrador'),
    security.generateCredentialsConfig('CEL1_TEST', 'ClaveEfimeraCel1#99', 'viewer', 'Celular 1'),
    security.generateCredentialsConfig('CEL2_TEST', 'ClaveEfimeraCel2#99', 'viewer', 'Celular 2')
  ];
  const { server } = createAppServer({
    autoStartWatcher: false,
    authConfig: ephemeralAccounts
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Bloqueo total sin sesión en endpoints privados y PDF
    const unauthState = await fetch(`${baseUrl}/api/state`);
    assert.equal(unauthState.status, 401);

    const unauthPdf = await fetch(`${baseUrl}/api/report/pdf?period=today`);
    assert.equal(unauthPdf.status, 401);

    // 2. WebSocket sin sesión debe rechazarse con código 4001
    const unauthWsCode = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('close', (code) => resolve(code));
    });
    assert.equal(unauthWsCode, 4001);

    // 3. Bloqueo anti-fuerza bruta tras 8 intentos fallidos hacia una cuenta
    for (let i = 0; i < 8; i += 1) {
      const badResp = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.77'
        },
        body: JSON.stringify({ username: 'ADMIN_TEST', password: 'wrong' })
      });
      assert.equal(badResp.status, 401);
    }
    const lockedResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.77'
      },
      body: JSON.stringify({ username: 'ADMIN_TEST', password: 'ClaveEfimeraAdmin#99' })
    });
    assert.equal(lockedResp.status, 429);

    // Verificar que otro usuario en el mismo Wi-Fi (198.51.100.77) NO quede bloqueado
    const celSameWifiOk = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.77'
      },
      body: JSON.stringify({ username: 'cel1 _ test', password: '  ClaveEfimeraCel1#99  ' })
    });
    assert.equal(celSameWifiOk.status, 200);

    // 4. Inicio de sesión legítimo de Admin y prueba de SESIÓN ÚNICA (abrir en otro navegador cierra la anterior)
    const loginBrowser1 = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
      body: JSON.stringify({ username: 'ADMIN_TEST', password: 'ClaveEfimeraAdmin#99' })
    });
    assert.equal(loginBrowser1.status, 200);
    const cookieBrowser1 = loginBrowser1.headers.getSetCookie()[0].split(';')[0];

    const wsBrowser1 = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: cookieBrowser1 }
    });
    await new Promise((resolve, reject) => {
      wsBrowser1.once('open', resolve);
      wsBrowser1.once('error', reject);
    });

    const wsBrowser1ClosedPromise = new Promise((resolve) => {
      wsBrowser1.once('close', (code) => resolve(code));
    });

    // Ahora el mismo usuario ADMIN_TEST inicia sesión en un SEGUNDO navegador
    const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.20'
      },
      body: JSON.stringify({ username: 'ADMIN_TEST', password: 'ClaveEfimeraAdmin#99' })
    });
    assert.equal(loginResp.status, 200);
    const loginAdminJson = await loginResp.json();
    assert.equal(loginAdminJson.role, 'admin');
    const setCookiesAdmin = loginResp.headers.getSetCookie();
    assert.match(setCookiesAdmin[0], /HttpOnly/i);
    const cookieHeader = setCookiesAdmin[0].split(';')[0];

    // El navegador 1 debe ser expulsado inmediatamente por WebSocket (4002) y por HTTP (401 sessionReplaced)
    const closedCode = await wsBrowser1ClosedPromise;
    assert.equal(closedCode, 4002);

    const kickedHttpResp = await fetch(`${baseUrl}/api/state`, {
      headers: { Cookie: cookieBrowser1 }
    });
    assert.equal(kickedHttpResp.status, 401);
    const kickedJson = await kickedHttpResp.json();
    assert.equal(kickedJson.sessionReplaced, true);

    // Iniciar sesión en los 2 Celulares independientes
    const cel1Resp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.11' },
      body: JSON.stringify({ username: 'CEL1_TEST', password: 'ClaveEfimeraCel1#99' })
    });
    assert.equal(cel1Resp.status, 200);
    const cel1Json = await cel1Resp.json();
    assert.equal(cel1Json.role, 'viewer');
    const cel1Cookie = cel1Resp.headers.getSetCookie()[0].split(';')[0];

    const cel2Resp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.12' },
      body: JSON.stringify({ username: 'CEL2_TEST', password: 'ClaveEfimeraCel2#99' })
    });
    assert.equal(cel2Resp.status, 200);
    const cel2Cookie = cel2Resp.headers.getSetCookie()[0].split(';')[0];

    // Verificar que los celulares (viewer) NO tienen acceso a configuración, simulador, QR ni borrado (403 Forbidden)
    const forbiddenSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cel1Cookie },
      body: JSON.stringify({ official_senders: 'intruso@correo.com' })
    });
    assert.equal(forbiddenSettings.status, 403);

    const forbiddenSim = await fetch(`${baseUrl}/api/payments/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cel1Cookie },
      body: JSON.stringify({ amount: 999999 })
    });
    assert.equal(forbiddenSim.status, 403);

    const forbiddenQr = await fetch(`${baseUrl}/api/network-info`, {
      headers: { Cookie: cel1Cookie }
    });
    assert.equal(forbiddenQr.status, 403);

    const forbiddenPdf = await fetch(`${baseUrl}/api/report/pdf?period=today`, {
      headers: { Cookie: cel1Cookie }
    });
    assert.equal(forbiddenPdf.status, 403);

    // Verificar que /api/state en celular oculta correos sensibles
    const viewerState = await fetch(`${baseUrl}/api/state`, {
      headers: { Cookie: cel1Cookie }
    }).then((r) => r.json());
    assert.equal(viewerState.role, 'viewer');
    assert.equal(viewerState.settings.email_user, undefined);
    assert.equal(viewerState.settings.official_senders, undefined);

    // 5. Verificar que guardar una clave de aplicación nunca la expone por API y queda cifrada en SQLite
    const saveRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader
      },
      body: JSON.stringify({
        business_name: 'Control de Pagos Bancolombia',
        email_provider: 'gmail',
        email_user: 'jhocamza@gmail.com',
        email_pass: 'clavePruebaTemporal1234',
        official_senders: 'jhocamza@gmail.com',
        sync_lookback: 'today'
      })
    }).then((r) => r.json());

    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.settings.has_password, true);
    assert.equal(saveRes.settings.email_pass, undefined);
    assert.ok(saveRes.encryptedVault && saveRes.encryptedVault.startsWith('enc:gcm:v1:'));
    assert.equal(saveRes.encryptedVault.includes('clavePruebaTemporal1234'), false);

    const rawDb = new DatabaseSync(db.DB_PATH, { readOnly: true });
    const rawRow = rawDb.prepare("SELECT value FROM settings WHERE key = 'email_pass'").get();
    rawDb.close();
    assert.ok(rawRow.value.startsWith('enc:gcm:v1:'));
    assert.equal(rawRow.value.includes('clavePruebaTemporal1234'), false);

    // Simular que Render entró en reposo y perdió la base de datos temporal
    db.updateSettings({ email_pass: '' }, 0);
    assert.equal(db.getAllSettings(false).has_password, false);

    // Verificar auto-restauración desde la bóveda cifrada AES-256-GCM sin volver a pedir la clave
    const restoreRes = await fetch(`${baseUrl}/api/settings/restore-vault`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader
      },
      body: JSON.stringify({ encryptedVault: saveRes.encryptedVault })
    }).then((r) => r.json());

    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.restored, true);
    assert.equal(restoreRes.settings.has_password, true);
    assert.equal(restoreRes.settings.email_pass, undefined);
    assert.equal(db.getAllSettings(true).email_pass, 'clavePruebaTemporal1234');

    // Limpiar clave temporal de prueba
    db.updateSettings({ email_pass: '' }, 0);

    // 6. Conectar 1 Admin + Celular 1 + Celular 2 vía WebSocket y verificar que TODOS reciben confirmación y voz,
    // pero los celulares reciben el correo remitente redactado y no pueden borrar pagos
    const clients = [
      new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookieHeader } }),
      new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cel1Cookie } }),
      new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cel2Cookie } })
    ];

    await Promise.all(
      clients.map(
        (ws) =>
          new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
          })
      )
    );

    const broadcastPromises = clients.map(
      (ws) =>
        new Promise((resolve) => {
          ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'new_payment') resolve(msg);
          });
        })
    );

    const simRes = await fetch(`${baseUrl}/api/payments/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader
      },
      body: JSON.stringify({ amount: 85000, channel: 'Transferencia Bancolombia', payer: 'PEDRO PEREZ' })
    }).then((r) => r.json());
    assert.equal(simRes.ok, true);

    const alerts = await Promise.all(broadcastPromises);
    assert.equal(alerts.length, 3);
    assert.equal(alerts[0].payment.voice_phrase, 'Has recibido ochenta y cinco mil pesos');
    assert.equal(alerts[1].payment.voice_phrase, 'Has recibido ochenta y cinco mil pesos');
    assert.equal(alerts[2].payment.voice_phrase, 'Has recibido ochenta y cinco mil pesos');
    assert.equal(alerts[1].payment.sender_email, 'Correo Oficial Verificado');
    assert.equal(alerts[2].payment.sender_email, 'Correo Oficial Verificado');

    // Verificar /api/sync-check tanto en Admin como en Celular
    const adminSync = await fetch(`${baseUrl}/api/sync-check`, {
      headers: { Cookie: cookieHeader }
    }).then((r) => r.json());
    assert.equal(adminSync.ok, true);
    assert.equal(adminSync.latestPayment.amount, 85000);
    assert.equal(Array.isArray(adminSync.devices), true);

    const phoneSync = await fetch(`${baseUrl}/api/sync-check`, {
      headers: { Cookie: cel1Cookie }
    }).then((r) => r.json());
    assert.equal(phoneSync.ok, true);
    assert.equal(phoneSync.latestPayment.amount, 85000);
    assert.equal(phoneSync.latestPayment.sender_email, 'Correo Oficial Verificado');

    // Verificar ping_app / pong_app bidireccional en el WebSocket de Admin PC
    const pongPromise = new Promise((resolve) => {
      clients[0].on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'pong_app') resolve(m);
      });
    });
    clients[0].send(JSON.stringify({ type: 'ping_app', ts: 12345 }));
    const pongMsg = await pongPromise;
    assert.equal(pongMsg.ts, 12345);
    assert.ok(pongMsg.revision >= 1);

    // Verificar que Celular 1 no puede borrar el pago (403)
    const forbiddenDel = await fetch(`${baseUrl}/api/payments/${simRes.payment.id}`, {
      method: 'DELETE',
      headers: { Cookie: cel1Cookie }
    });
    assert.equal(forbiddenDel.status, 403);

    const pdfResp = await fetch(`${baseUrl}/api/report/pdf?period=today`, {
      headers: { Cookie: cookieHeader }
    });
    assert.equal(pdfResp.status, 200);
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
    assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');

    await fetch(`${baseUrl}/api/payments-test`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader }
    });

    // 7. Cerrar sesión invalida inmediatamente el token aunque se reenvíe la cookie
    await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookieHeader }
    });

    const afterLogout = await fetch(`${baseUrl}/api/state`, {
      headers: { Cookie: cookieHeader }
    });
    assert.equal(afterLogout.status, 401);

    for (const ws of clients) {
      ws.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
