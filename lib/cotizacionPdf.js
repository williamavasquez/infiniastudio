const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

// Colores de marca (los mismos tokens del admin).
const NEGRO = '#4e4c4c';
const CREMA = '#faf7f0';
const BEIGE = '#e3d9cf';
const NARANJA = '#f07a4a';

const LOGO = path.join(__dirname, '..', 'public', 'logo.png');
const MARGEN = 50;

function money(n) {
  return `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fecha(d) {
  return new Date(d).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fechaVencimiento(cotizacion) {
  const d = new Date(cotizacion.created_at);
  d.setDate(d.getDate() + cotizacion.validez_dias);
  return fecha(d);
}

function encabezado(doc, cotizacion) {
  if (fs.existsSync(LOGO)) {
    try {
      doc.image(LOGO, MARGEN, 40, { fit: [110, 50], align: 'left' });
    } catch (err) {
      // Un logo ilegible no puede romper la generación del PDF.
    }
  }

  doc
    .fillColor(NEGRO)
    .fontSize(20)
    .font('Helvetica-Bold')
    .text('COTIZACIÓN', MARGEN, 46, { align: 'right' })
    .fontSize(11)
    .font('Helvetica')
    .fillColor(NARANJA)
    .text(cotizacion.numero, { align: 'right' })
    .fillColor(NEGRO)
    .fontSize(9)
    .text(`Emitida: ${fecha(cotizacion.created_at)}`, { align: 'right' })
    .text(`Válida hasta: ${fechaVencimiento(cotizacion)}`, { align: 'right' });

  doc.moveTo(MARGEN, 108).lineTo(doc.page.width - MARGEN, 108).strokeColor(BEIGE).lineWidth(1).stroke();
  doc.y = 126;
}

function datosCliente(doc, cotizacion) {
  const y = doc.y;
  doc.roundedRect(MARGEN, y, doc.page.width - MARGEN * 2, 70, 6).fillColor(CREMA).fill();

  doc.fillColor(NEGRO).fontSize(8).font('Helvetica-Bold').text('CLIENTE', MARGEN + 14, y + 12);
  doc.fontSize(12).font('Helvetica-Bold').text(cotizacion.paciente || '', MARGEN + 14, y + 26);

  const detalle = [
    `${cotizacion.tipo_doc || 'Doc'}: ${cotizacion.documento}`,
    cotizacion.celular ? `Cel: ${cotizacion.celular}` : null,
    cotizacion.correo || null,
  ].filter(Boolean);
  doc.fontSize(9).font('Helvetica').text(detalle.join('   ·   '), MARGEN + 14, y + 46);

  doc.y = y + 88;

  if (cotizacion.titulo) {
    doc.fontSize(13).font('Helvetica-Bold').fillColor(NEGRO).text(cotizacion.titulo, MARGEN, doc.y);
    doc.moveDown(0.6);
  }
}

// Anchos de columna de la tabla de ítems, de izquierda a derecha.
const COLS = { sku: 74, cant: 40, precio: 82, importe: 86 };

function filaItem(doc, y, celdas, { negrita = false, color = NEGRO } = {}) {
  const izquierda = MARGEN;
  const derecha = doc.page.width - MARGEN;
  const anchoDescripcion = derecha - izquierda - COLS.sku - COLS.cant - COLS.precio - COLS.importe;

  doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(color);
  let x = izquierda;
  doc.text(celdas[0], x, y, { width: COLS.sku, ellipsis: true });
  x += COLS.sku;
  doc.text(celdas[1], x, y, { width: anchoDescripcion - 8 });
  x += anchoDescripcion;
  doc.text(celdas[2], x, y, { width: COLS.cant, align: 'center' });
  x += COLS.cant;
  doc.text(celdas[3], x, y, { width: COLS.precio, align: 'right' });
  x += COLS.precio;
  doc.text(celdas[4], x, y, { width: COLS.importe, align: 'right' });

  // La descripción puede envolver en varias líneas: la fila mide lo más alto.
  const alto = doc.heightOfString(celdas[1], { width: anchoDescripcion - 8 });
  return Math.max(alto, 12);
}

function tablaItems(doc, items) {
  const derecha = doc.page.width - MARGEN;

  let y = doc.y + 6;
  doc.rect(MARGEN, y - 6, derecha - MARGEN, 22).fillColor(BEIGE).fill();
  filaItem(doc, y, ['SKU', 'Descripción', 'Cant.', 'P. unit.', 'Importe'], { negrita: true });
  y += 22;

  items.forEach((item) => {
    // Salto de página conservando el encabezado de la tabla.
    if (y > doc.page.height - 150) {
      doc.addPage();
      y = MARGEN;
      doc.rect(MARGEN, y - 6, derecha - MARGEN, 22).fillColor(BEIGE).fill();
      filaItem(doc, y, ['SKU', 'Descripción', 'Cant.', 'P. unit.', 'Importe'], { negrita: true });
      y += 22;
    }

    const alto = filaItem(doc, y, [
      item.sku || '',
      item.nombre,
      String(item.cantidad),
      money(item.precio_unitario),
      money(item.cantidad * item.precio_unitario),
    ]);

    y += alto + 8;
    doc.moveTo(MARGEN, y - 4).lineTo(derecha, y - 4).strokeColor('#f1ede6').lineWidth(0.5).stroke();
  });

  doc.y = y + 6;
}

function total(doc, cotizacion) {
  const derecha = doc.page.width - MARGEN;
  const ancho = 210;
  const x = derecha - ancho;
  const y = doc.y;

  doc.roundedRect(x, y, ancho, 34, 6).fillColor(NARANJA).fill();
  doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold').text('TOTAL', x + 14, y + 12);
  doc.fontSize(13).text(money(cotizacion.total), x, y + 10, { width: ancho - 14, align: 'right' });

  doc.y = y + 50;
}

function pie(doc, cotizacion) {
  if (cotizacion.observaciones) {
    doc.fillColor(NEGRO).fontSize(9).font('Helvetica-Bold').text('Observaciones', MARGEN, doc.y);
    doc.font('Helvetica').fontSize(9).text(cotizacion.observaciones, { width: doc.page.width - MARGEN * 2 });
    doc.moveDown(1);
  }

  doc
    .fontSize(8)
    .fillColor(NEGRO)
    .opacity(0.65)
    .text(
      `Precios en soles. Esta cotización es válida hasta el ${fechaVencimiento(cotizacion)} y está sujeta a disponibilidad.`,
      MARGEN,
      doc.page.height - 70,
      { width: doc.page.width - MARGEN * 2, align: 'center' }
    )
    .opacity(1);
}

// Genera el PDF en memoria. El estado/semáforo es información interna del
// panel y a propósito NO aparece en el documento que ve el cliente.
function generarCotizacionPdf(cotizacion) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGEN });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      encabezado(doc, cotizacion);
      datosCliente(doc, cotizacion);
      tablaItems(doc, cotizacion.items);
      total(doc, cotizacion);
      pie(doc, cotizacion);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function nombreArchivo(cotizacion) {
  return `${cotizacion.numero}.pdf`;
}

module.exports = { generarCotizacionPdf, nombreArchivo };
