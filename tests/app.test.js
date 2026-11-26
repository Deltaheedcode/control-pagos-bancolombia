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

test('Seguridad E2E: bloqueo sin sesión, límite anti-fuerza bruta, cifrado en SQLite, 3 teléfonos y revocación', async () => {
  // Credenciales efímeras generadas solo en memoria para el test
  const ephemeralAuth = security.generateCredentialsConfig('USUARIO_TEST', 'ClaveEfimera#Test99');
  const { server } = createAppServer({
    autoStartWatcher: false,
    authConfig: ephemeralAuth
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

    // 3. Bloqueo anti-fuerza bruta tras 5 intentos fallidos desde una IP atacante
    for (let i = 0; i < 5; i += 1) {
      const badResp = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.77'
        },
        body: JSON.stringify({ username: 'INTRUSO', password: 'wrong' })
      });
      assert.equal(badResp.status, 401);
    }
    const lockedResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.77'
      },
      body: JSON.stringify({ username: 'USUARIO_TEST', password: 'ClaveEfimera#Test99' })
    });
    assert.equal(lockedResp.status, 429);

    // 4. Inicio de sesión legítimo y cookie HttpOnly
    const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '198.51.100.10'
      },
      body: JSON.stringify({ username: 'USUARIO_TEST', password: 'ClaveEfimera#Test99' })
    });
    assert.equal(loginResp.status, 200);
    const setCookie = loginResp.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/i);
    const cookieHeader = setCookie.split(';')[0];

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

    const rawDb = new DatabaseSync(db.DB_PATH, { readOnly: true });
    const rawRow = rawDb.prepare("SELECT value FROM settings WHERE key = 'email_pass'").get();
    rawDb.close();
    assert.ok(rawRow.value.startsWith('enc:gcm:v1:'));
    assert.equal(rawRow.value.includes('clavePruebaTemporal1234'), false);

    // Limpiar clave temporal de prueba
    db.updateSettings({ email_pass: '' });

    // 6. Conectar 3 pantallas autenticadas (PC + 2 teléfonos) y verificar alerta de voz + PDF
    const clients = [
      new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookieHeader } }),
      new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookieHeader } }),
      new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookieHeader } })
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
