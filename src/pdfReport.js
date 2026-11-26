const PDFDocument = require('pdfkit');
const NumberToSpanish = require('../public/numberToSpanish');

function formatDateTimeColombia(isoString) {
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(d);
  } catch (_) {
    return isoString || '';
  }
}

function generatePaymentsPdfStream({
  res,
  businessName,
  periodLabel,
  officialSenders,
  payments,
  totalAmount
}) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 42, bottom: 48, left: 42, right: 42 },
    bufferPages: true,
    info: {
      Title: `Reporte de Pagos - ${businessName || 'Bancolombia'}`,
      Author: businessName || 'Control de Pagos Bancolombia'
    }
  });

  doc.pipe(res);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const startX = doc.page.margins.left;

  // Encabezado con franja estilo corporativo (oscuro + acento amarillo Bancolombia)
  doc.save();
  doc.roundedRect(startX, 36, pageWidth, 74, 8).fill('#181B23');
  doc.rect(startX, 104, pageWidth, 6).fill('#FDDA24');

  doc
    .fillColor('#FDDA24')
    .font('Helvetica-Bold')
    .fontSize(16)
    .text((businessName || 'CONTROL DE PAGOS BANCOLOMBIA').toUpperCase(), startX + 18, 50, {
      width: pageWidth - 36
    });

  doc
    .fillColor('#FFFFFF')
    .font('Helvetica')
    .fontSize(10)
    .text('Reporte Detallado de Pagos Verificados por Correo Electrónico (Cruce de Cuentas)', startX + 18, 72);

  doc
    .fillColor('#CBD5E1')
    .fontSize(8.5)
    .text(`Generado: ${formatDateTimeColombia(new Date().toISOString())}`, startX + 18, 88);
  doc.restore();

  // Bloque de metadatos y resumen rápido superior
  let cursorY = 124;
  doc.save();
  doc.roundedRect(startX, cursorY, pageWidth, 52, 6).fillAndStroke('#F8FAFC', '#E2E8F0');

  doc.fillColor('#334155').font('Helvetica-Bold').fontSize(9);
  doc.text('Periodo consultado:', startX + 14, cursorY + 10);
  doc.font('Helvetica').fillColor('#0F172A').text(periodLabel || 'Todos los registros', startX + 112, cursorY + 10);

  doc.fillColor('#334155').font('Helvetica-Bold').text('Remitente(s) oficial(es):', startX + 14, cursorY + 28);
  doc
    .font('Helvetica')
    .fillColor('#0F172A')
    .text((officialSenders || []).join(', ') || 'No especificado', startX + 128, cursorY + 28, {
      width: pageWidth - 290,
      ellipsis: true,
      lineBreak: false
    });

  // Mini tarjeta derecha en encabezado
  doc.fillColor('#065F46').font('Helvetica-Bold').fontSize(9);
  doc.text(`Pagos: ${payments.length}`, startX + pageWidth - 155, cursorY + 10, {
    width: 140,
    align: 'right'
  });
  doc.fontSize(12).text(NumberToSpanish.formatCOP(totalAmount), startX + pageWidth - 155, cursorY + 25, {
    width: 140,
    align: 'right'
  });
  doc.restore();

  cursorY += 68;

  // Columnas de la tabla
  const cols = [
    { label: '#', width: 26, align: 'left' },
    { label: 'Fecha y Hora', width: 112, align: 'left' },
    { label: 'Canal / Detalle / Pagador', width: 175, align: 'left' },
    { label: 'Correo Verificado / Ref.', width: 125, align: 'left' },
    { label: 'Monto Recibido', width: pageWidth - (26 + 112 + 175 + 125), align: 'right' }
  ];

  function drawTableHeader(y) {
    doc.save();
    doc.rect(startX, y, pageWidth, 24).fill('#1E293B');
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5);
    let colX = startX;
    for (const col of cols) {
      doc.text(col.label, colX + 6, y + 7, {
        width: col.width - 12,
        align: col.align
      });
      colX += col.width;
    }
    doc.restore();
    return y + 24;
  }

  cursorY = drawTableHeader(cursorY);

  // Orden cronológico ascendente o descendente: para cruce de cuentas cronológico de arriba hacia abajo es muy claro
  const orderedPayments = [...payments].sort(
    (a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime()
  );

  if (orderedPayments.length === 0) {
    doc.save();
    doc.rect(startX, cursorY, pageWidth, 40).fillAndStroke('#FFFFFF', '#E2E8F0');
    doc
      .fillColor('#64748B')
      .font('Helvetica-Oblique')
      .fontSize(10)
      .text('No hay pagos registrados para el periodo seleccionado.', startX, cursorY + 14, {
        width: pageWidth,
        align: 'center'
      });
    doc.restore();
    cursorY += 54;
  } else {
    orderedPayments.forEach((p, idx) => {
      const detailLines = [p.channel || 'Pago recibido'];
      if (p.payer) detailLines.push(`De: ${p.payer}`);
      else if (p.subject) detailLines.push(p.subject.slice(0, 48));
      if (p.is_test) detailLines.push('[REGISTRO DE PRUEBA]');

      const detailText = detailLines.join('\n');
      const refText = [
        p.sender_email || '',
        p.reference ? `Ref: ${p.reference}` : ''
      ]
        .filter(Boolean)
        .join('\n');

      const rowHeight = Math.max(28, detailLines.length > 1 || p.reference ? 34 : 26);

      if (cursorY + rowHeight + 95 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        cursorY = doc.page.margins.top;
        cursorY = drawTableHeader(cursorY);
      }

      const bgColor = idx % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
      doc.save();
      doc.rect(startX, cursorY, pageWidth, rowHeight).fill(bgColor);
      doc
        .moveTo(startX, cursorY + rowHeight)
        .lineTo(startX + pageWidth, cursorY + rowHeight)
        .lineWidth(0.5)
        .strokeColor('#E2E8F0')
        .stroke();

      let colX = startX;
      doc.fillColor('#475569').font('Helvetica').fontSize(8);
      doc.text(String(idx + 1), colX + 6, cursorY + 7, { width: cols[0].width - 10 });
      colX += cols[0].width;

      doc.fillColor('#0F172A').fontSize(8);
      doc.text(formatDateTimeColombia(p.received_at), colX + 6, cursorY + 7, {
        width: cols[1].width - 12
      });
      colX += cols[1].width;

      doc.fillColor('#1E293B').font('Helvetica-Bold').fontSize(8);
      doc.text(detailLines[0], colX + 6, cursorY + 5, {
        width: cols[2].width - 12,
        lineBreak: false,
        ellipsis: true
      });
      if (detailLines.length > 1) {
        doc.fillColor('#64748B').font('Helvetica').fontSize(7.5);
        doc.text(detailLines.slice(1).join(' • '), colX + 6, cursorY + 17, {
          width: cols[2].width - 12,
          lineBreak: false,
          ellipsis: true
        });
      }
      colX += cols[2].width;

      doc.fillColor('#334155').font('Helvetica').fontSize(7.5);
      doc.text(refText, colX + 6, cursorY + 5, {
        width: cols[3].width - 12,
        height: rowHeight - 6,
        ellipsis: true
      });
      colX += cols[3].width;

      doc.fillColor('#047857').font('Helvetica-Bold').fontSize(9.5);
      doc.text(NumberToSpanish.formatCOP(p.amount), colX + 6, cursorY + 8, {
        width: cols[4].width - 12,
        align: 'right'
      });

      doc.restore();
      cursorY += rowHeight;
    });
  }

  // Caja final de SUMA TOTAL abajo para cruce de cuentas
  cursorY += 14;
  if (cursorY + 82 > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    cursorY = doc.page.margins.top + 10;
  }

  doc.save();
  doc.roundedRect(startX, cursorY, pageWidth, 68, 8).fillAndStroke('#ECFDF5', '#10B981');

  doc
    .fillColor('#065F46')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text('RESUMEN PARA CRUCE DE CUENTAS', startX + 16, cursorY + 12);

  doc
    .fillColor('#047857')
    .font('Helvetica')
    .fontSize(9)
    .text(`Total de transacciones verificadas: ${orderedPayments.length}`, startX + 16, cursorY + 29);

  doc
    .fillColor('#064E3B')
    .font('Helvetica-Oblique')
    .fontSize(8.5)
    .text(
      `En letras: ${NumberToSpanish.integerToSpanishWords(Math.floor(totalAmount)).toUpperCase()} PESOS M/CTE`,
      startX + 16,
      cursorY + 46,
      { width: pageWidth - 210, ellipsis: true, lineBreak: false }
    );

  doc
    .fillColor('#065F46')
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('SUMA TOTAL RECIBIDA', startX + pageWidth - 195, cursorY + 13, {
      width: 178,
      align: 'right'
    });

  doc
    .fillColor('#047857')
    .font('Helvetica-Bold')
    .fontSize(17)
    .text(NumberToSpanish.formatCOP(totalAmount), startX + pageWidth - 195, cursorY + 30, {
      width: 178,
      align: 'right'
    });
  doc.restore();

  // Numeración de páginas al pie
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i += 1) {
    doc.switchToPage(pageRange.start + i);
    doc
      .fillColor('#94A3B8')
      .font('Helvetica')
      .fontSize(8)
      .text(
        `Control de Pagos Bancolombia • Página ${i + 1} de ${pageRange.count}`,
        startX,
        doc.page.height - 32,
        { width: pageWidth, align: 'center', lineBreak: false }
      );
  }

  doc.end();
}

module.exports = {
  generatePaymentsPdfStream
};
