// Chequeo de la lógica de plata del inventario: promedio ponderado, reinicio
// con stock <= 0, anulación de compras y bloqueo de ajustes bajo cero.
// Corre contra la base LOCAL y deja datos de prueba (SKU CHK*): nunca apuntarlo
// a producción.
//   DATABASE_URL=postgresql://localhost:5432/infinia_dev PGSSLMODE=disable node scripts/check-inventario.js
const assert = require('assert');
if (!/@?(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('check-inventario solo corre contra una base local (DATABASE_URL con localhost).');
  process.exit(1);
}
const { pool } = require('../lib/db');
const inv = require('../lib/inventarioRepo');
const compras = require('../lib/comprasRepo');

const HOY = new Date().toISOString().slice(0, 10);
const cerca = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: esperado ${b}, salió ${a}`);

async function producto(sku, factor = 1) {
  await pool.query('DELETE FROM servicio_insumos WHERE producto_id IN (SELECT id FROM inventario WHERE sku = $1)', [sku]);
  await pool.query('DELETE FROM movimientos WHERE producto_id IN (SELECT id FROM inventario WHERE sku = $1)', [sku]);
  await pool.query('DELETE FROM compra_items WHERE producto_id IN (SELECT id FROM inventario WHERE sku = $1)', [sku]);
  await pool.query('DELETE FROM inventario WHERE sku = $1', [sku]);
  const { rows } = await pool.query(
    "INSERT INTO inventario (sku, nombre, unidad_base, unidad_compra, factor) VALUES ($1, $1, 'ml', 'frasco', $2) RETURNING id",
    [sku, factor]
  );
  return rows[0].id;
}

const estado = async (id) => {
  const p = await inv.getProducto(id);
  return { stock: p.stock, promedio: p.costo_promedio };
};

async function comprar(proveedorId, items) {
  return compras.createCompra({ proveedor_id: proveedorId, fecha: HOY, items }, null);
}

(async () => {
  const { rows: prev } = await pool.query("SELECT id FROM proveedores WHERE nombre = 'CHK proveedor'");
  const prov = prev[0]
    ? prev[0].id
    : (await pool.query("INSERT INTO proveedores (nombre) VALUES ('CHK proveedor') RETURNING id")).rows[0].id;

  // Función pura
  cerca(inv.promedioPonderado(10, 2, 10, 4), 3, 'promedio ponderado');
  cerca(inv.promedioPonderado(0, 2, 10, 4), 4, 'stock 0 reemplaza el costo');
  cerca(inv.promedioPonderado(-5, 2, 10, 4), 4, 'stock negativo reemplaza el costo');

  // Compras: factor 100 (frasco de 100 ml). 2 frascos a S/ 200 = 400 ml a 2.00/ml.
  const a = await producto('CHK0001', 100);
  const c1 = await comprar(prov, [{ producto_id: a, cantidad: 2, costo_unitario: 200 }]);
  let e = await estado(a);
  cerca(e.stock, 200, 'stock tras compra 1');
  cerca(e.promedio, 2, 'promedio tras compra 1');
  assert.strictEqual(c1.total, 400);

  // 1 frasco a S/ 400 = 100 ml a 4.00/ml -> (200*2 + 100*4)/300 = 2.6667
  const c2 = await comprar(prov, [{ producto_id: a, cantidad: 1, costo_unitario: 400 }]);
  e = await estado(a);
  cerca(e.stock, 300, 'stock tras compra 2');
  cerca(e.promedio, 800 / 300, 'promedio ponderado tras compra 2');

  // Anular la compra 2 vuelve al promedio de la compra 1 (repaso del libro).
  await compras.anularCompra(c2.id, null);
  e = await estado(a);
  cerca(e.stock, 200, 'stock tras anular compra 2');
  cerca(e.promedio, 2, 'promedio tras anular compra 2');
  await assert.rejects(() => compras.anularCompra(c2.id, null), /ya está anulada/);

  // Ajuste bajo cero bloqueado; hasta cero, permitido.
  await assert.rejects(() => inv.ajustarStock({ productoId: a, cantidad: -201, motivo: 'x' }), /negativo/);
  await assert.rejects(() => inv.ajustarStock({ productoId: a, cantidad: -1, motivo: '' }), /motivo/);
  await inv.ajustarStock({ productoId: a, cantidad: -200, motivo: 'merma' });
  e = await estado(a);
  cerca(e.stock, 0, 'stock tras ajuste a cero');

  // Con stock 0 el promedio viejo se descarta: 1 frasco a 300 -> 3.00/ml.
  await comprar(prov, [{ producto_id: a, cantidad: 1, costo_unitario: 300 }]);
  e = await estado(a);
  cerca(e.promedio, 3, 'reinicio del promedio con stock 0');

  // Anular una compra cuando hubo consumo en el medio: el repaso sigue el libro.
  const b = await producto('CHK0002', 1);
  await comprar(prov, [{ producto_id: b, cantidad: 10, costo_unitario: 2 }]); // 10 a 2
  await inv.insertarMovimiento(pool, { productoId: b, tipo: 'consumo', cantidad: -10 }); // stock 0
  const c3 = await comprar(prov, [{ producto_id: b, cantidad: 10, costo_unitario: 6 }]); // reinicia: 6
  cerca((await estado(b)).promedio, 6, 'reinicio tras consumo');
  await compras.anularCompra(c3.id, null);
  e = await estado(b);
  cerca(e.stock, 0, 'stock tras anular c3');
  cerca(e.promedio, 2, 'promedio tras anular c3 vuelve al de la compra 1');

  // Dos compras concurrentes del mismo producto no pierden ninguna entrada.
  const d = await producto('CHK0003', 1);
  await Promise.all([1, 2, 3, 4].map(() => comprar(prov, [{ producto_id: d, cantidad: 5, costo_unitario: 1 }])));
  cerca((await estado(d)).stock, 20, 'compras concurrentes');

  console.log('check-inventario: OK');
  await pool.end();
})().catch(async (err) => {
  console.error('check-inventario: FALLÓ\n', err);
  await pool.end();
  process.exit(1);
});
