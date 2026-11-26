const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');

const NumberToSpanish = require('../public/numberToSpanish');
const parser = require('../src/parser');
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

test('Filtro anti-fraude: acepta remitente oficial, rechaza falsos, spoofing y compras salientes', () => {
  // 1. Prueba válida desde jhocamza@gmail.com
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
  assert.equal(okTest.payment.voice_phrase, 'Has recibido setenta y cinco mil pesos');

  // 2. Rechazar correo enviado desde otro remitente falso
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

  // 3. Rechazar correo con cabeceras SPF/DKIM fallidas (suplantación)
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

  // 4. Rechazar compras o retiros propios (salidas de dinero)
  const outgoing = parser.analyzeEmailForPayment({
    fromAddress: 'alertasynotificaciones@notificacionesbancolombia.com',
    fromName: 'Bancolombia',
    subject: 'Alerta Bancolombia',
    textBody: 'Bancolombia le informa Compra por $42.000,00 en EXITO con tu T.Debito *1234.',
    officialSenders: parser.DEFAULT_BANCOLOMBIA_SENDERS
  });
  assert.equal(outgoing.accepted, false);
  assert.equal(outgoing.reason, 'outgoing_transaction');

  // 5. Aceptar formato real Bancolombia QR / Transferencia
  const realBank = parser.analyzeEmailForPayment({
    fromAddress: 'alertasynotificaciones@notificacionesbancolombia.com',
    fromName: 'Alertas y Notificaciones',
    subject: '¡Recibiste un pago con Código QR!',
    htmlBody: '<div>Bancolombia: Recibiste una transferencia por <b>$ 148.500,00</b> de MARIA LOPEZ en tu cuenta *9876. Comprobante QR998877.</div>',
    headers: new Map([['authentication-results', 'mx.google.com; spf=pass; dkim=pass']]),
    officialSenders: parser.DEFAULT_BANCOLOMBIA_SENDERS
  });
  assert.equal(realBank.accepted, true);
  assert.equal(realBank.payment.amount, 148500);
  assert.equal(realBank.payment.channel, 'Código QR Bancolombia');
  assert.equal(realBank.payment.reference, 'QR998877');
});

test('Servidor E2E: sincronización en 3 teléfonos + configuración inicial jhocamza@gmail.com + reporte PDF', async () => {
  const { server } = createAppServer({ autoStartWatcher: false });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Verificar configuración inicial solicitada por el usuario
    const stateRes = await fetch(`${baseUrl}/api/state`).then((r) => r.json());
    assert.equal(stateRes.ok, true);
    assert.equal(stateRes.settings.official_senders, 'jhocamza@gmail.com');

    // Verificar generación de código QR para celulares
    const netRes = await fetch(`${baseUrl}/api/network-info`).then((r) => r.json());
    assert.equal(netRes.ok, true);
    assert.match(netRes.qrDataUrl, /^data:image\/png;base64,/);

    // Conectar simultáneamente 1 PC + 2 Teléfonos vía WebSocket
    const clients = [
      new WebSocket(`ws://127.0.0.1:${port}/ws`),
      new WebSocket(`ws://127.0.0.1:${port}/ws`),
      new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ];

    await Promise.all(
      clients.map(
        (ws, idx) =>
          new Promise((resolve, reject) => {
            ws.once('open', () => {
              ws.send(
                JSON.stringify({
                  type: 'hello',
                  name: idx === 0 ? 'PC Caja' : `Teléfono ${idx}`,
                  voiceEnabled: true
                })
              );
              resolve();
            });
            ws.once('error', reject);
          })
      )
    );

    // Preparar escucha de alerta simultánea en los 3 dispositivos
    const paymentBroadcastPromises = clients.map(
      (ws) =>
        new Promise((resolve) => {
          ws.on('message', (raw) => {
            const data = JSON.parse(String(raw));
            if (data.type === 'new_payment') {
              resolve(data);
            }
          });
        })
    );

    // Simular llegada de un pago de $85.000
    const simRes = await fetch(`${baseUrl}/api/payments/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 85000,
        channel: 'Transferencia Bancolombia',
        payer: 'PEDRO PEREZ'
      })
    }).then((r) => r.json());

    assert.equal(simRes.ok, true);
    assert.equal(simRes.payment.amount, 85000);

    const receivedAlerts = await Promise.all(paymentBroadcastPromises);
    assert.equal(receivedAlerts.length, 3);
    for (const alert of receivedAlerts) {
      assert.equal(alert.announceVoice, true);
      assert.equal(alert.payment.voice_phrase, 'Has recibido ochenta y cinco mil pesos');
    }

    // Verificar descarga del Reporte PDF con el detallado y suma total
    const pdfResp = await fetch(`${baseUrl}/api/report/pdf?period=today`);
    assert.equal(pdfResp.status, 200);
    assert.equal(pdfResp.headers.get('content-type'), 'application/pdf');
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
    assert.ok(pdfBuf.length > 1000, 'El PDF debe tener contenido válido');
    assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');

    // Limpiar pagos de prueba para dejar la base de datos limpia al usuario
    const cleanRes = await fetch(`${baseUrl}/api/payments-test`, { method: 'DELETE' }).then((r) =>
      r.json()
    );
    assert.equal(cleanRes.ok, true);
    assert.ok(cleanRes.deletedCount >= 1);

    for (const ws of clients) {
      ws.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
