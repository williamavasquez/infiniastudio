const ExcelJS = require('exceljs');
const { pool } = require('./db');
const inv = require('./inventarioRepo');

async function getInsumos(servicioSku) {
  const { rows } = await pool.query(
    `SELECT si.producto_id, i.sku, i.nombre, i.unidad_base, si.cantidad::float8 AS cantidad
     FROM servicio_insumos si JOIN inventario i ON i.id = si.producto_id
     WHERE si.servicio_sku = $1 ORDER BY i.nombre`,
    [servicioSku]
  );
  return rows;
}

// Reemplaza la guía completa de un servicio (es lo que edita el formulario).
async function setInsumos(servicioSku, items) {
  const lineas = (Array.isArray(items) ? items : []).map((l) => ({
    productoId: Number(l.producto_id),
    cantidad: inv.decimal(l.cantidad, 'La cantidad', { positivo: true }),
  }));
  if (lineas.some((l) => !l.productoId || l.cantidad === null)) throw new Error('Cada insumo necesita producto y cantidad');
  if (new Set(lineas.map((l) => l.productoId)).size !== lineas.length) throw new Error('Un producto está repetido en la guía');

  await inv.conTransaccion(async (client) => {
    const { rows } = await client.query('SELECT 1 FROM servicios WHERE sku = $1', [servicioSku]);
    if (!rows[0]) throw new Error('Servicio no encontrado');
    await reemplazarGuia(client, servicioSku, lineas);
  });
  return getInsumos(servicioSku);
}

async function reemplazarGuia(client, servicioSku, lineas) {
  if (lineas.length) {
    const { rows } = await client.query('SELECT id, discontinuado_at FROM inventario WHERE id = ANY($1)', [lineas.map((l) => l.productoId)]);
    if (rows.length !== lineas.length) throw new Error('Uno de los productos no existe');
    // Un insumo descontinuado no se agrega; si ya estaba en la guía se conserva.
    const { rows: actuales } = await client.query('SELECT producto_id FROM servicio_insumos WHERE servicio_sku = $1', [servicioSku]);
    const yaEstaba = new Set(actuales.map((a) => a.producto_id));
    if (rows.some((r) => r.discontinuado_at && !yaEstaba.has(r.id))) throw new Error('No se puede agregar un producto descontinuado');
  }
  await client.query('DELETE FROM servicio_insumos WHERE servicio_sku = $1', [servicioSku]);
  for (const l of lineas) {
    await client.query('INSERT INTO servicio_insumos (servicio_sku, producto_id, cantidad) VALUES ($1, $2, $3)', [servicioSku, l.productoId, l.cantidad]);
  }
}

// "Dónde se usa": servicios cuya guía consume este producto.
async function dondeSeUsa(productoId) {
  const { rows } = await pool.query(
    `SELECT si.servicio_sku, s.nombre, s.categoria, si.cantidad::float8 AS cantidad
     FROM servicio_insumos si JOIN servicios s ON s.sku = si.servicio_sku
     WHERE si.producto_id = $1 ORDER BY s.nombre`,
    [productoId]
  );
  return rows;
}

// Descontinuar un producto, con reemplazo opcional. Con `cambiarInsumos` el
// reemplazo pasa a ocupar el lugar del viejo en todas las guías (si una guía ya
// tenía el reemplazo, se queda con su cantidad y se descarta la fila vieja).
async function descontinuarProducto(id, reemplazadoPor, cambiarInsumos) {
  const reemplazo = reemplazadoPor ? Number(reemplazadoPor) : null;
  if (cambiarInsumos && !reemplazo) throw new Error('Elegí el producto de reemplazo para cambiarlo en las guías');
  return inv.conTransaccion(async (client) => {
    const n = await inv.descontinuar(client, [id], reemplazo);
    if (!n) throw new Error('El producto no existe o ya estaba descontinuado');
    let guias = 0;
    if (cambiarInsumos) {
      await client.query(
        `DELETE FROM servicio_insumos o USING servicio_insumos r
         WHERE o.producto_id = $1 AND r.servicio_sku = o.servicio_sku AND r.producto_id = $2`,
        [id, reemplazo]
      );
      guias = (await client.query('UPDATE servicio_insumos SET producto_id = $2 WHERE producto_id = $1', [id, reemplazo])).rowCount;
    }
    return { guias_actualizadas: guias };
  });
}

// Excel: servicio_sku | producto_sku | cantidad. Cada servicio que aparece en
// el archivo queda con EXACTAMENTE las filas del archivo (reemplaza su guía);
// los que no aparecen no se tocan. Todo o nada.
async function importarGuias(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('No se pudo leer el archivo: tiene que ser un Excel (.xlsx)');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene hojas');

  const col = {};
  ws.getRow(1).eachCell((cell, n) => {
    const h = String(cell.value && cell.value.result !== undefined ? cell.value.result : cell.value || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (['servicio_sku', 'servicio'].includes(h)) col.servicio = n;
    else if (['producto_sku', 'producto'].includes(h)) col.producto = n;
    else if (h === 'cantidad') col.cantidad = n;
  });
  if (!col.servicio || !col.producto || !col.cantidad) throw new Error('Faltan las columnas servicio_sku, producto_sku y cantidad en la primera fila');

  const texto = (row, n) => String(row.getCell(n).value?.result ?? row.getCell(n).value ?? '').trim().toUpperCase();
  const filas = [];
  const errores = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const servicio = texto(row, col.servicio);
    const producto = texto(row, col.producto);
    const cantidadRaw = row.getCell(col.cantidad).value?.result ?? row.getCell(col.cantidad).value;
    if (!servicio && !producto && (cantidadRaw === null || cantidadRaw === undefined || cantidadRaw === '')) return;
    try {
      if (!servicio || !producto) throw new Error('falta el SKU del servicio o del producto');
      const cantidad = inv.decimal(cantidadRaw, 'la cantidad', { positivo: true });
      if (cantidad === null) throw new Error('falta la cantidad');
      filas.push({ fila: n, servicio, producto, cantidad });
    } catch (err) {
      errores.push({ fila: n, error: err.message });
    }
  });
  if (!filas.length && !errores.length) throw new Error('El archivo no tiene filas para cargar');

  return inv.conTransaccion(async (client) => {
    const { rows: servs } = await client.query('SELECT sku FROM servicios WHERE sku = ANY($1)', [[...new Set(filas.map((f) => f.servicio))]]);
    const { rows: prods } = await client.query('SELECT id, sku FROM inventario WHERE sku = ANY($1)', [[...new Set(filas.map((f) => f.producto))]]);
    const okServ = new Set(servs.map((s) => s.sku));
    const idProd = new Map(prods.map((p) => [p.sku, p.id]));
    const porServicio = new Map();
    for (const f of filas) {
      if (!okServ.has(f.servicio)) errores.push({ fila: f.fila, error: `no existe el servicio ${f.servicio}` });
      else if (!idProd.has(f.producto)) errores.push({ fila: f.fila, error: `no existe el producto ${f.producto}` });
      else {
        const lineas = porServicio.get(f.servicio) || [];
        if (lineas.some((l) => l.productoId === idProd.get(f.producto))) errores.push({ fila: f.fila, error: `${f.producto} está repetido en ${f.servicio}` });
        else lineas.push({ productoId: idProd.get(f.producto), cantidad: f.cantidad });
        porServicio.set(f.servicio, lineas);
      }
    }
    if (errores.length) {
      const err = new Error(`El archivo tiene ${errores.length} error(es); no se cargó nada`);
      err.errores = errores.sort((a, b) => a.fila - b.fila);
      throw err;
    }
    for (const [sku, lineas] of porServicio) await reemplazarGuia(client, sku, lineas);
    return { servicios: porServicio.size, filas: filas.length };
  });
}

module.exports = { getInsumos, setInsumos, dondeSeUsa, descontinuarProducto, importarGuias };
