const { pool } = require('./db');
const inv = require('./inventarioRepo');

const COMPRA_SELECT = `
  c.id, c.proveedor_id, p.nombre AS proveedor, c.nro_factura, c.fecha,
  c.total::float8 AS total, c.archivo, c.anulada_at, c.created_at, u.username AS usuario
`;
const COMPRA_FROM = `
  FROM compras c JOIN proveedores p ON p.id = c.proveedor_id LEFT JOIN usuarios u ON u.id = c.usuario_id
`;

async function listCompras({ offset = 0, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COMPRA_SELECT}, (SELECT count(*)::int FROM compra_items ci WHERE ci.compra_id = c.id) AS items
     ${COMPRA_FROM} ORDER BY c.fecha DESC, c.id DESC LIMIT $1 OFFSET $2`,
    [limit + 1, offset]
  );
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

async function getCompra(id) {
  const { rows } = await pool.query(`SELECT ${COMPRA_SELECT} ${COMPRA_FROM} WHERE c.id = $1`, [id]);
  if (!rows[0]) return null;
  const { rows: items } = await pool.query(
    `SELECT ci.id, ci.producto_id, i.sku, i.nombre, i.unidad_compra, i.unidad_base, i.factor::float8 AS factor,
            ci.cantidad::float8 AS cantidad, ci.costo_unitario::float8 AS costo_unitario, ci.sku_proveedor,
            round(ci.cantidad * ci.costo_unitario, 2)::float8 AS subtotal
     FROM compra_items ci JOIN inventario i ON i.id = ci.producto_id
     WHERE ci.compra_id = $1 ORDER BY ci.id`,
    [id]
  );
  return { ...rows[0], items };
}

// Alta de compra: cabecera + líneas + movimientos + costo promedio, todo en
// una transacción (si una línea falla no queda nada a medias). Las líneas
// llegan en unidad de compra y se convierten a unidad base con el factor.
async function createCompra(input, usuarioId) {
  const proveedorId = Number(input.proveedor_id);
  if (!proveedorId) throw new Error('El proveedor es requerido');
  const fecha = String(input.fecha || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('La fecha es requerida');
  const lineas = (Array.isArray(input.items) ? input.items : []).map((l) => ({
    productoId: Number(l.producto_id),
    cantidad: inv.decimal(l.cantidad, 'La cantidad', { positivo: true }),
    costo: inv.decimal(l.costo_unitario, 'El costo unitario'),
    skuProveedor: String(l.sku_proveedor || '').trim() || null,
  }));
  if (!lineas.length) throw new Error('La compra necesita al menos un producto');
  if (lineas.some((l) => !l.productoId || l.cantidad === null || l.costo === null)) {
    throw new Error('Cada línea necesita producto, cantidad y costo unitario');
  }
  const total = inv.redondear(lineas.reduce((acc, l) => acc + inv.redondear(l.cantidad * l.costo, 2), 0), 2);

  const id = await inv.conTransaccion(async (client) => {
    const { rows: prov } = await client.query('SELECT 1 FROM proveedores WHERE id = $1', [proveedorId]);
    if (!prov[0]) throw new Error('El proveedor no existe');
    const { rows } = await client.query(
      `INSERT INTO compras (proveedor_id, nro_factura, fecha, total, usuario_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [proveedorId, String(input.nro_factura || '').trim() || null, fecha, total, usuarioId]
    );
    const compraId = rows[0].id;

    // En orden de producto para tomar los locks siempre en el mismo orden
    // (dos compras simultáneas no se traban entre sí).
    for (const l of [...lineas].sort((a, b) => a.productoId - b.productoId)) {
      // FOR UPDATE antes de insertar la línea: el INSERT toma un lock más
      // débil sobre el producto (por la FK) y, si dos compras lo hacen a la
      // vez y recién después piden el lock fuerte, se traban entre sí.
      const { rows: prod } = await client.query(
        'SELECT factor::float8 AS factor, discontinuado_at FROM inventario WHERE id = $1 FOR UPDATE',
        [l.productoId]
      );
      if (!prod[0]) throw new Error('Uno de los productos no existe');
      if (prod[0].discontinuado_at) throw new Error('No se puede comprar un producto descontinuado');
      await client.query(
        'INSERT INTO compra_items (compra_id, producto_id, cantidad, costo_unitario, sku_proveedor) VALUES ($1, $2, $3, $4, $5)',
        [compraId, l.productoId, l.cantidad, l.costo, l.skuProveedor]
      );
      await inv.registrarEntrada(client, {
        productoId: l.productoId,
        tipo: 'compra',
        cantidad: inv.redondear(l.cantidad * prod[0].factor, 4),
        costoUnitario: inv.redondear(l.costo / prod[0].factor, 6),
        refTipo: 'compra',
        refId: compraId,
        usuarioId,
      });
    }
    return compraId;
  });
  return getCompra(id);
}

// Anular = revertir. No se borra nada: cada línea genera un movimiento
// `anulacion` de signo contrario y el costo promedio se recalcula repasando
// el libro de cada producto sin esta compra.
async function anularCompra(id, usuarioId) {
  await inv.conTransaccion(async (client) => {
    const { rows } = await client.query('SELECT anulada_at FROM compras WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new Error('Compra no encontrada');
    if (rows[0].anulada_at) throw new Error('La compra ya está anulada');
    await client.query('UPDATE compras SET anulada_at = now() WHERE id = $1', [id]);

    // Lo que efectivamente entró al stock, tal cual quedó en el libro.
    const { rows: entradas } = await client.query(
      `SELECT producto_id, SUM(cantidad)::float8 AS cantidad FROM movimientos
       WHERE ref_tipo = 'compra' AND ref_id = $1 AND tipo = 'compra' GROUP BY producto_id ORDER BY producto_id`,
      [id]
    );
    for (const e of entradas) {
      await inv.leerStock(client, e.producto_id, { bloquear: true });
      await inv.insertarMovimiento(client, {
        productoId: e.producto_id,
        tipo: 'anulacion',
        cantidad: -e.cantidad,
        motivo: 'Anulación de compra',
        refTipo: 'compra',
        refId: id,
        usuarioId,
      });
      await inv.recalcularPromedio(client, e.producto_id);
    }
  });
  return getCompra(id);
}

module.exports = { listCompras, getCompra, createCompra, anularCompra };
