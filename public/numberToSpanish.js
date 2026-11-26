(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NumberToSpanish = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const UNIDADES = [
    '', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
    'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
    'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
    'veinte', 'veintiún', 'veintidós', 'veintitrés', 'veinticuatro',
    'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'
  ];

  const DECENAS = [
    '', '', '', 'treinta', 'cuarenta', 'cincuenta',
    'sesenta', 'setenta', 'ochenta', 'noventa'
  ];

  const CENTENAS = [
    '', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos',
    'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'
  ];

  function convertGroupUpTo999(n) {
    if (n === 0) return '';
    if (n === 100) return 'cien';

    const c = Math.floor(n / 100);
    const rem = n % 100;
    const parts = [];

    if (c > 0) parts.push(CENTENAS[c]);

    if (rem > 0) {
      if (rem < 30) {
        parts.push(UNIDADES[rem]);
      } else {
        const d = Math.floor(rem / 10);
        const u = rem % 10;
        if (u === 0) {
          parts.push(DECENAS[d]);
        } else {
          parts.push(DECENAS[d] + ' y ' + UNIDADES[u]);
        }
      }
    }

    return parts.join(' ');
  }

  function convertMillionsGroup(n) {
    if (n === 0) return '';
    if (n < 1000) return convertGroupUpTo999(n);

    const thousands = Math.floor(n / 1000);
    const remainder = n % 1000;
    const parts = [];

    if (thousands === 1) {
      parts.push('mil');
    } else {
      parts.push(convertGroupUpTo999(thousands) + ' mil');
    }

    if (remainder > 0) {
      parts.push(convertGroupUpTo999(remainder));
    }

    return parts.join(' ');
  }

  function integerToSpanishWords(num) {
    const n = Math.floor(Math.abs(Number(num) || 0));
    if (n === 0) return 'cero';

    const millions = Math.floor(n / 1000000);
    const belowMillion = n % 1000000;
    const parts = [];

    if (millions > 0) {
      if (millions === 1) {
        parts.push('un millón');
      } else {
        parts.push(convertMillionsGroup(millions) + ' millones');
      }
    }

    if (belowMillion > 0) {
      parts.push(convertMillionsGroup(belowMillion));
    }

    return parts.join(' ');
  }

  function paymentVoicePhrase(amount) {
    const val = Math.abs(Number(amount) || 0);
    const pesos = Math.floor(val);
    const centavos = Math.round((val - pesos) * 100);

    let currencyWord = 'pesos';
    if (pesos === 1) {
      currencyWord = 'peso';
    } else if (pesos >= 1000000 && pesos % 1000000 === 0) {
      currencyWord = 'de pesos';
    }

    let phrase = `Has recibido ${integerToSpanishWords(pesos)} ${currencyWord}`;
    if (centavos > 0) {
      const centWord = centavos === 1 ? 'centavo' : 'centavos';
      phrase += ` con ${integerToSpanishWords(centavos)} ${centWord}`;
    }
    return phrase;
  }

  function formatCOP(amount) {
    const val = Number(amount) || 0;
    const hasCents = Math.round((val - Math.floor(val)) * 100) !== 0;
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: hasCents ? 2 : 0
    }).format(val);
  }

  return {
    integerToSpanishWords,
    paymentVoicePhrase,
    formatCOP
  };
});
