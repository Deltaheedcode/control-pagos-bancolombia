const NumberToSpanish = require('../public/numberToSpanish');

const DEFAULT_BANCOLOMBIA_SENDERS = [
  'alertasynotificaciones@notificacionesbancolombia.com',
  'alertasynotificaciones@bancolombia.com.co',
  'notificaciones@bancolombia.com.co',
  'notificaciones@notificacionesbancolombia.com'
];

function normalizeSenderList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean);
  }
  return String(raw)
    .split(/[,;\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isSenderAuthorized(fromAddress, officialSendersRaw) {
  const sender = String(fromAddress || '').trim().toLowerCase();
  if (!sender) return false;
  const allowed = normalizeSenderList(officialSendersRaw);
  if (allowed.length === 0) return false;

  return allowed.some((rule) => {
    if (rule.startsWith('*@')) {
      const domain = rule.slice(1); // @domain.com
      return sender.endsWith(domain);
    }
    if (rule.startsWith('@')) {
      return sender.endsWith(rule);
    }
    return sender === rule;
  });
}

function checkAuthenticationHeaders(headersMap) {
  if (!headersMap || typeof headersMap.get !== 'function') {
    return { status: 'unknown', spoofSuspected: false, detail: 'Sin cabeceras de autenticación' };
  }
  const authResults = String(headersMap.get('authentication-results') || '').toLowerCase();
  if (!authResults) {
    return { status: 'unknown', spoofSuspected: false, detail: 'Mensaje local o sin Authentication-Results' };
  }

  const spfPass = authResults.includes('spf=pass');
  const dkimPass = authResults.includes('dkim=pass');
  const dmarcPass = authResults.includes('dmarc=pass');
  const spfFail = authResults.includes('spf=fail') || authResults.includes('spf=softfail');
  const dkimFail = authResults.includes('dkim=fail');
  const dmarcFail = authResults.includes('dmarc=fail');

  if (dmarcFail || (spfFail && !dkimPass) || (dkimFail && !spfPass)) {
    return {
      status: 'fail',
      spoofSuspected: true,
      detail: 'Alerta: Falló validación SPF/DKIM/DMARC (posible correo suplantado)'
    };
  }

  if (spfPass || dkimPass || dmarcPass) {
    return {
      status: 'pass',
      spoofSuspected: false,
      detail: 'Autenticidad de correo verificada (SPF/DKIM válido)'
    };
  }

  return { status: 'neutral', spoofSuspected: false, detail: 'Cabecera presente sin fallo reportado' };
}

function stripHtmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(br|p|div|tr|td|th|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#36;/g, '$')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function parseColombianAmountString(rawToken) {
  if (!rawToken) return null;
  let cleaned = String(rawToken)
    .replace(/[^\d.,]/g, '')
    .replace(/^[.,]+|[.,]+$/g, '');

  if (!cleaned || !/\d/.test(cleaned)) return null;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');

  let normalized = cleaned;

  if (hasDot && hasComma) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    if (lastComma > lastDot) {
      // Formato colombiano: 1.250.000,00
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // Formato anglosajón (usado en algunas alertas Bancolombia): 1,250,000.00
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasDot) {
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      // Ej: 1.250.000
      normalized = parts.join('');
    } else {
      const decimals = parts[1];
      if (decimals.length === 3) {
        // En COP $50.000 siempre son cincuenta mil pesos
        normalized = parts.join('');
      } else {
        // Ej: 50000.00 o 50000.50
        normalized = cleaned;
      }
    }
  } else if (hasComma) {
    const parts = cleaned.split(',');
    if (parts.length > 2) {
      // Ej: 1,250,000
      normalized = parts.join('');
    } else {
      const decimals = parts[1];
      if (decimals.length === 3) {
        // Ej: 50,000 -> cincuenta mil
        normalized = parts.join('');
      } else {
        // Ej: 50000,00 -> cincuenta mil
        normalized = cleaned.replace(',', '.');
      }
    }
  }

  const num = Number(normalized);
  if (!Number.isFinite(num) || num <= 0) return null;
  // Evitar números absurdamente grandes (ej. números de referencia de 15 dígitos)
  if (num > 5000000000) return null;
  return Math.round(num * 100) / 100;
}

function classifyDirection(fullText) {
  const lower = String(fullText || '').toLowerCase();

  const incomingPatterns = [
    /\brecibiste\b/,
    /\bha\s+recibido\b/,
    /\bhas\s+recibido\b/,
    /\brecepci[oó]n\b/,
    /\btransferencia\s+recibida\b/,
    /\bpago\s+recibido\b/,
    /\babono\b/,
    /\babonado\b/,
    /\bconsignaci[oó]n\b/,
    /\bte\s+enviaron\b/,
    /\bte\s+transfirieron\b/,
    /\bte\s+pagaron\b/,
    /\bventa\s+con\s+(c[oó]digo\s+)?qr\b/,
    /\bpago\s+con\s+(c[oó]digo\s+)?qr\b/,
    /\brecibiste\s+plata\b/,
    /\bingreso\b/
  ];

  const outgoingPatterns = [
    /\bcompraste\b/,
    /\ble\s+informa\s+compra\b/,
    /\bretiraste\b/,
    /\ble\s+informa\s+retiro\b/,
    /\bpagaste\b/,
    /\bpago\s+de\s+factura\b/,
    /\btransferiste\b/,
    /\benviaste\b/,
    /\brealizaste\s+una?\s+(transferencia|compra|pago)\b/,
    /\bd[eé]bito\s+autom[aá]tico\b/,
    /\bcompra\s+aprobada\b/
  ];

  const hasIncoming = incomingPatterns.some((re) => re.test(lower));
  const hasOutgoing = outgoingPatterns.some((re) => re.test(lower));

  if (hasOutgoing && !hasIncoming) return 'outgoing';
  if (hasIncoming) return 'incoming';
  return 'neutral';
}

function extractAmountFromText(subject, bodyText) {
  const combined = `${subject || ''}\n${bodyText || ''}`;

  // Prioridad 1: Monto precedido de contexto explícito de pago + símbolo $ o COP
  const contextualCurrencyRegex = /(?:por\s+valor\s+de|por\s+un\s+valor\s+de|valor\s*:?|monto\s*:?|recibiste(?:\s+una?\s+\w+)?\s+por|transferencia\s+por|pago\s+por|abono\s+por|consignaci[oó]n\s+por|por)\s*(?:cop|\$)\s*([\d]{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi;
  let match = contextualCurrencyRegex.exec(combined);
  if (match) {
    const val = parseColombianAmountString(match[1]);
    if (val !== null) return val;
  }

  // Prioridad 2: Cualquier monto con signo $ o prefijo/sufijo COP
  const currencySymbolRegex = /(?:cop\s*\$?|\$\s*)([\d]{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi;
  const currencyCandidates = [];
  while ((match = currencySymbolRegex.exec(combined)) !== null) {
    const val = parseColombianAmountString(match[1]);
    if (val !== null) currencyCandidates.push(val);
  }
  if (currencyCandidates.length > 0) {
    return currencyCandidates[0];
  }

  // Prioridad 3: Monto seguido de la palabra "pesos" o "cop"
  const pesosSuffixRegex = /\b([\d]{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d{3,9}(?:[.,]\d{1,2})?)\s*(?:pesos|cop)\b/gi;
  match = pesosSuffixRegex.exec(combined);
  if (match) {
    const val = parseColombianAmountString(match[1]);
    if (val !== null) return val;
  }

  // Prioridad 4: Monto precedido de palabras clave aunque no tenga signo $ (útil en correos de prueba)
  const keywordNumberRegex = /(?:valor|monto|pago|transferencia|recibiste|abono|pagaron)\s*(?:de|por|:)?\s*([\d]{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{3,9})\b/gi;
  match = keywordNumberRegex.exec(combined);
  if (match) {
    const val = parseColombianAmountString(match[1]);
    if (val !== null) return val;
  }

  return null;
}

function extractPaymentMetadata(subject, bodyText) {
  const combined = `${subject || ''}\n${bodyText || ''}`;
  const lower = combined.toLowerCase();

  // Detectar canal
  let channel = 'Transferencia Bancolombia';
  if (/\bqr\b/.test(lower)) {
    channel = 'Código QR Bancolombia';
  } else if (/\bnequi\b/.test(lower)) {
    channel = 'Nequi a Bancolombia';
  } else if (/\bbre-?b\b|\bllave\b/.test(lower)) {
    channel = 'Bre-B / Llave';
  } else if (/\bconsignaci[oó]n\b/.test(lower)) {
    channel = 'Consignación';
  } else if (!/bancolombia/.test(lower)) {
    channel = 'Notificación de Pago';
  }

  // Intentar extraer nombre de quien envía ("de JUAN PEREZ" / "enviada por ...")
  let payer = '';
  const payerPatterns = [
    /(?:transferencia|pago|giro)\s+(?:por\s+\$?\s*[\d.,]+\s+)?de\s+([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ\s]{2,40}?)(?:\s+en\s+tu|\s+a\s+tu|\s+el\s+\d|[.,;\n]|$)/i,
    /(?:enviad[ao]\s+por|remitente\s*:|origen\s*:|pagador\s*:)\s*([^\n.,;]{3,45})/i
  ];
  for (const re of payerPatterns) {
    const m = re.exec(combined);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (!/^(bancolombia|cuenta|ahorros|corriente|valor|qr)\b/i.test(candidate)) {
        payer = candidate;
        break;
      }
    }
  }

  // Intentar extraer comprobante / referencia / CUS
  let reference = '';
  const refPatterns = [
    /(?:comprobante|referencia|cus|aprobaci[oó]n|transacci[oó]n)\s*(?:no\.?|n[uú]mero|#|:)?\s*([A-Z0-9-]{4,25})/i
  ];
  for (const re of refPatterns) {
    const m = re.exec(combined);
    if (m && m[1]) {
      reference = m[1].trim();
      break;
    }
  }

  return { channel, payer, reference };
}

function analyzeEmailForPayment({
  fromAddress,
  fromName,
  subject,
  textBody,
  htmlBody,
  date,
  messageId,
  headers,
  officialSenders
}) {
  const senderNormalized = String(fromAddress || '').trim().toLowerCase();
  const authorized = isSenderAuthorized(senderNormalized, officialSenders);

  if (!authorized) {
    return {
      accepted: false,
      reason: 'unauthorized_sender',
      reasonDetail: `Remitente no autorizado (${senderNormalized || 'desconocido'})`
    };
  }

  const authCheck = checkAuthenticationHeaders(headers);
  if (authCheck.spoofSuspected) {
    return {
      accepted: false,
      reason: 'spoof_suspected',
      reasonDetail: authCheck.detail
    };
  }

  const plainFromHtml = stripHtmlToText(htmlBody);
  const fullBody = [textBody || '', plainFromHtml].filter(Boolean).join('\n');
  const direction = classifyDirection(`${subject || ''}\n${fullBody}`);

  if (direction === 'outgoing') {
    return {
      accepted: false,
      reason: 'outgoing_transaction',
      reasonDetail: 'Correo corresponde a una salida/compra/retiro, no a un pago recibido'
    };
  }

  const amount = extractAmountFromText(subject, fullBody);
  if (amount === null || amount <= 0) {
    return {
      accepted: false,
      reason: 'no_amount_found',
      reasonDetail: 'El correo del remitente oficial no contiene un monto de pago identificable'
    };
  }

  const meta = extractPaymentMetadata(subject, fullBody);
  const snippet = (fullBody || subject || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  return {
    accepted: true,
    payment: {
      message_id: messageId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sender_email: senderNormalized,
      sender_name: fromName || '',
      subject: String(subject || '(Sin asunto)').trim(),
      amount,
      formatted_amount: NumberToSpanish.formatCOP(amount),
      voice_phrase: NumberToSpanish.paymentVoicePhrase(amount),
      channel: meta.channel,
      payer: meta.payer,
      reference: meta.reference,
      auth_status: authCheck.status,
      auth_detail: authCheck.detail,
      snippet,
      received_at: date ? new Date(date).toISOString() : new Date().toISOString()
    }
  };
}

module.exports = {
  DEFAULT_BANCOLOMBIA_SENDERS,
  normalizeSenderList,
  isSenderAuthorized,
  checkAuthenticationHeaders,
  parseColombianAmountString,
  classifyDirection,
  extractAmountFromText,
  analyzeEmailForPayment
};
