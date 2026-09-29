// Datos de demo para el módulo de inventario (proveedores, categorías,
// productos, conteo inicial, compras, consumos simulados y guías de consumo).
// Pasa por los mismos repos que la app, así stock y costo promedio salen
// igual que en uso real. Solo corre si el inventario está vacío.
//
//   npm run seed:inventario
require('dotenv').config({ quiet: true });
const { pool } = require('../lib/db');
const inv = require('../lib/inventarioRepo');
const compras = require('../lib/comprasRepo');
const insumos = require('../lib/insumosRepo');
const proveedoresRepo = require('../lib/proveedoresRepo');

const PROVEEDORES = {
  dermo: { nombre: 'Dermo Import Perú SAC', ruc: '20601234561', contacto: 'Lucía Ramos', telefono: '987654321', correo: 'ventas@dermoimport.pe' },
  meraki: { nombre: 'Meraki Cosmética SAC', ruc: '20605678902', contacto: 'Andrea Salas', telefono: '976543210', correo: 'pedidos@meraki.pe' },
  medica: { nombre: 'Distribuidora Médica Lima SAC', ruc: '20509876543', contacto: 'Jorge Quispe', telefono: '965432109', correo: 'jquispe@dmlima.pe' },
  fitpro: { nombre: 'Fit Pro Perú SAC', ruc: '20607654324', contacto: 'Diego Torres', telefono: '954321098', correo: 'diego@fitpro.pe' },
  textil: { nombre: 'Textiles Promo SAC', ruc: '20503456785', contacto: 'Rosa Medina', telefono: '943210987', correo: 'rmedina@textilespromo.pe' },
  beauty: { nombre: 'BeautyPro Insumos SAC', ruc: '20608765436', contacto: 'Carla Vega', telefono: '932109876', correo: 'carla@beautypro.pe' },
};

const CATEGORIAS = {
  Tienda: ['Fórmulas', 'Pilates', 'Merch'],
  'Consumibles Estética': ['Toxinas', 'Rellenos', 'Faciales', 'Endovenoso'],
  Operación: ['Descartables', 'Limpieza'],
};

// sku: solo en productos de la tienda (reusan el SKU del servicio).
// inicial/consumo en unidad base; costo inicial por unidad base.
// provs: [clave proveedor, SKU proveedor].
const PRODUCTOS = [
  { k: 'anuket', sku: 'TIEFOR0001', nombre: 'Meraki Anuket Gold Serum', fam: 'Fórmulas', base: 'unidad', compra: 'caja', factor: 6, min: 4, inicial: [3, 55], consumo: 10, provs: [['meraki', 'MK-AGS-30']] },
  { k: 'diaSerum', sku: 'TIEFOR0002', nombre: 'Meraki Día Serum', fam: 'Fórmulas', base: 'unidad', compra: 'caja', factor: 6, min: 4, inicial: [2, 38], consumo: 0, provs: [['meraki', 'MK-DS-30']] },
  { k: 'espuma', sku: 'TIEFOR0003', nombre: 'Meraki Espuma Piel Sensible Kiladerm', fam: 'Fórmulas', base: 'unidad', compra: 'caja', factor: 6, min: 3, inicial: [8, 30], consumo: 5, provs: [['meraki', 'MK-EPS-150']] },
  { k: 'nocheSerum', sku: 'TIEFOR0004', nombre: 'Meraki Noche Serum', fam: 'Fórmulas', base: 'unidad', compra: 'caja', factor: 6, min: 4, inicial: [5, 38], consumo: 4, provs: [['meraki', 'MK-NS-30']] },
  { k: 'mug', sku: 'TIEMER0001', nombre: 'Mug Infinia', fam: 'Merch', base: 'unidad', compra: 'caja', factor: 12, min: 6, inicial: [20, 15], consumo: 6, provs: [['textil', 'TP-MUG-INF']] },
  { k: 'liga', sku: 'TIEPIL0002', nombre: 'Liga x 1', fam: 'Pilates', base: 'unidad', compra: 'paquete', factor: 10, min: 10, inicial: [12, 8], consumo: 14, provs: [['fitpro', 'FP-LIG-01']] },
  { k: 'medias', sku: 'TIEPIL0005', nombre: 'Medias Infinia', fam: 'Pilates', base: 'par', compra: 'paquete', factor: 12, min: 12, inicial: [30, 12], consumo: 40, provs: [['textil', 'TP-MED-ANT']] },
  { k: 'pesas', sku: 'TIEPIL0007', nombre: 'Pesas de mano (par)', fam: 'Pilates', base: 'par', compra: 'par', factor: 1, min: 4, inicial: [6, 45], consumo: 2, provs: [['fitpro', 'FP-PES-1KG']] },
  { k: 'toalla', sku: 'TIEPIL0009', nombre: 'Toalla Infinia', fam: 'Pilates', base: 'unidad', compra: 'paquete', factor: 10, min: 10, inicial: [15, 20], consumo: 24, provs: [['textil', 'TP-TOA-MF']] },

  { k: 'dysport', nombre: 'Dysport 300U', descripcion: 'Toxina botulínica abobotulinumtoxinA, vial de 300 U', fam: 'Toxinas', base: 'U', compra: 'vial', factor: 300, min: 600, inicial: [900, 3.5], consumo: 1350, provs: [['dermo', 'DYS-300']] },
  { k: 'xeomin', nombre: 'Xeomin 100U', descripcion: 'Toxina botulínica incobotulinumtoxinA, vial de 100 U', fam: 'Toxinas', base: 'U', compra: 'vial', factor: 100, min: 200, inicial: [300, 9], consumo: 290, provs: [['dermo', 'XEO-100']] },
  { k: 'belotero', nombre: 'Belotero Balance 1 ml', fam: 'Rellenos', base: 'jeringa', compra: 'jeringa', factor: 1, min: 3, inicial: [4, 520], consumo: 5, provs: [['dermo', 'BEL-BAL-1'], ['medica', 'DML-44781']] },
  { k: 'revUltra', nombre: 'Revanesse Ultra 1 ml', fam: 'Rellenos', base: 'jeringa', compra: 'jeringa', factor: 1, min: 2, inicial: [6, 480], consumo: 2, provs: [['dermo', 'REV-ULT-1']] },
  { k: 'revRevise', nombre: 'Revanesse Revise 1 ml', fam: 'Rellenos', base: 'jeringa', compra: 'jeringa', factor: 1, min: 2, inicial: [1, 450], consumo: 1, provs: [['dermo', 'REV-RVS-1']] },
  { k: 'radiesse', nombre: 'Radiesse Classic 1.5 ml', fam: 'Rellenos', base: 'jeringa', compra: 'jeringa', factor: 1, min: 2, inicial: [3, 780], consumo: 1, provs: [['dermo', 'RAD-CL-15']] },
  { k: 'jalupro', nombre: 'Jalupro Classic', descripcion: 'Kit de 2 viales + 2 ampollas', fam: 'Rellenos', base: 'kit', compra: 'kit', factor: 1, min: 3, inicial: [5, 260], consumo: 4, provs: [['dermo', 'JAL-CLA']] },
  { k: 'crema', nombre: 'Crema limpiadora facial', fam: 'Faciales', base: 'ml', compra: 'frasco', factor: 500, min: 500, inicial: [800, 0.18], consumo: 1260, provs: [['beauty', 'BP-CLF-500']] },
  { k: 'mascarilla', nombre: 'Mascarilla hidratante', fam: 'Faciales', base: 'unidad', compra: 'caja', factor: 10, min: 10, inicial: [25, 6], consumo: 30, provs: [['beauty', 'BP-MHI-10']] },
  { k: 'vitC', nombre: 'Vitamina C 7.5 g / 50 ml', fam: 'Endovenoso', base: 'ampolla', compra: 'caja', factor: 10, min: 5, inicial: [8, 35], consumo: 12, provs: [['medica', 'DML-VC75']] },
  { k: 'suero', nombre: 'Suero fisiológico 100 ml', fam: 'Endovenoso', base: 'unidad', compra: 'caja', factor: 50, min: 20, inicial: [60, 2.8], consumo: 25, provs: [['medica', 'DML-SF100']] },
  { k: 'guantes', nombre: 'Guantes de nitrilo talla M', fam: 'Descartables', base: 'unidad', compra: 'caja', factor: 100, min: 200, inicial: [300, 0.25], consumo: 450, provs: [['medica', 'DML-GN-M']] },
  { k: 'gasas', nombre: 'Gasas estériles 10x10', fam: 'Descartables', base: 'unidad', compra: 'paquete', factor: 100, min: 200, inicial: [250, 0.1], consumo: 120, provs: [['medica', 'DML-GE-1010']] },
  { k: 'jeringa', nombre: 'Jeringa 1 ml', fam: 'Descartables', base: 'unidad', compra: 'caja', factor: 100, min: 100, inicial: [180, 0.35], consumo: 90, provs: [['medica', 'DML-JER-1']] },
  { k: 'alcohol', nombre: 'Alcohol 70%', fam: 'Limpieza', base: 'ml', compra: 'frasco', factor: 1000, min: null, inicial: [2500, 0.012], consumo: 800, provs: [['medica', 'DML-ALC-1L']] },
];

// Cantidades en unidad de compra, costo por unidad de compra (incl. IGV).
const COMPRAS = [
  { prov: 'textil', factura: 'F001-0077', fecha: '2026-07-28', items: [['medias', 3, 150], ['toalla', 2, 210]] },
  { prov: 'dermo', factura: 'F001-00231', fecha: '2026-08-05', items: [['belotero', 4, 540], ['jalupro', 5, 270]] },
  { prov: 'meraki', factura: 'E001-1452', fecha: '2026-08-20', items: [['anuket', 2, 330], ['espuma', 1, 186], ['nocheSerum', 1, 240]] },
  { prov: 'medica', factura: 'F002-8841', fecha: '2026-09-02', items: [['vitC', 1, 360], ['guantes', 5, 28], ['jeringa', 1, 38]] },
  { prov: 'dermo', factura: 'F001-00298', fecha: '2026-09-12', items: [['dysport', 3, 1080], ['xeomin', 2, 950]] },
  { prov: 'beauty', factura: 'B001-5520', fecha: '2026-09-18', items: [['crema', 2, 95], ['mascarilla', 2, 65]] },
  { prov: 'fitpro', factura: 'F001-0412', fecha: '2026-09-20', items: [['liga', 2, 70]], anular: true },
];

// Guía de consumo (cantidades en unidad base por servicio).
const DESCARTABLES = [['guantes', 2], ['gasas', 4], ['alcohol', 5]];
const GUIAS = {
  ESTTOX0001: [['dysport', 100], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0002: [['dysport', 10], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0003: [['dysport', 100], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0004: [['dysport', 50], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0005: [['dysport', 40], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0006: [['dysport', 60], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0007: [['dysport', 10], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0008: [['xeomin', 40], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0009: [['xeomin', 4], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0010: [['xeomin', 40], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0011: [['xeomin', 20], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0012: [['xeomin', 15], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0013: [['xeomin', 24], ...DESCARTABLES, ['jeringa', 1]],
  ESTTOX0014: [['xeomin', 4], ...DESCARTABLES, ['jeringa', 1]],
  ESTACI0001: [['belotero', 1], ...DESCARTABLES],
  ESTACI0004: [['revRevise', 1], ...DESCARTABLES],
  ESTACI0005: [['revUltra', 1], ...DESCARTABLES],
  ESTRAD0001: [['radiesse', 1], ...DESCARTABLES],
  ESTMES0001: [['jalupro', 1], ...DESCARTABLES],
  ESTLIM0001: [['crema', 15], ['mascarilla', 1], ['guantes', 2]],
  ESTLIM0002: [['crema', 15], ['mascarilla', 1], ['guantes', 2]],
  ESTLIM0003: [['crema', 15], ['mascarilla', 1], ['guantes', 2]],
  ESTLIM0005: [['crema', 20], ['mascarilla', 2], ['guantes', 2]],
  ESTINY0001: [['vitC', 1], ['suero', 1], ['guantes', 2], ['gasas', 2], ['alcohol', 5]],
};

(async () => {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM inventario');
  if (rows[0].n) throw new Error(`El inventario ya tiene ${rows[0].n} productos: el seed solo corre sobre un inventario vacío.`);

  // Los movimientos quedan a nombre de la primera cuenta (el admin inicial).
  const { rows: u } = await pool.query('SELECT id FROM usuarios ORDER BY id LIMIT 1');
  const USUARIO_ID = u[0]?.id ?? null;

  const prov = {};
  for (const [k, p] of Object.entries(PROVEEDORES)) prov[k] = (await proveedoresRepo.createProveedor(p)).id;

  const fam = {};
  for (const [cat, familias] of Object.entries(CATEGORIAS)) {
    const padre = await inv.createCategoria({ nombre: cat });
    for (const f of familias) fam[f] = (await inv.createCategoria({ nombre: f, parent_id: padre.id })).id;
  }

  const id = {};
  for (const p of PRODUCTOS) {
    const creado = await inv.createProducto({
      sku: p.sku,
      nombre: p.nombre,
      descripcion: p.descripcion,
      categoria_id: fam[p.fam],
      unidad_base: p.base,
      unidad_compra: p.compra,
      factor: p.factor,
      stock_minimo: p.min,
      proveedores: p.provs.map(([k, sku]) => ({ proveedor_id: prov[k], sku_proveedor: sku })),
    });
    id[p.k] = creado.id;
    await inv.conTransaccion((client) =>
      inv.registrarEntrada(client, {
        productoId: creado.id, tipo: 'conteo_inicial', cantidad: p.inicial[0], costoUnitario: p.inicial[1], usuarioId: USUARIO_ID,
      })
    );
  }

  for (const c of COMPRAS) {
    const compra = await compras.createCompra({
      proveedor_id: prov[c.prov],
      nro_factura: c.factura,
      fecha: c.fecha,
      items: c.items.map(([k, cantidad, costo]) => ({
        producto_id: id[k],
        cantidad,
        costo_unitario: costo,
        sku_proveedor: PRODUCTOS.find((p) => p.k === k).provs.find(([pk]) => pk === c.prov)?.[1],
      })),
    }, USUARIO_ID);
    if (c.anular) await compras.anularCompra(compra.id, USUARIO_ID);
  }

  // Lo que hará la importación diaria de ventas (fase 5): puede dejar stock
  // negativo (Liga x 1 queda en -2 a propósito).
  for (const p of PRODUCTOS.filter((x) => x.consumo)) {
    await inv.conTransaccion((client) =>
      inv.insertarMovimiento(client, {
        productoId: id[p.k], tipo: 'consumo', cantidad: -p.consumo, motivo: 'Consumo simulado (seed)', usuarioId: USUARIO_ID,
      })
    );
  }

  for (const [servicioSku, lineas] of Object.entries(GUIAS)) {
    await insumos.setInsumos(servicioSku, lineas.map(([k, cantidad]) => ({ producto_id: id[k], cantidad })));
  }

  // Revanesse Revise se reemplaza por Ultra, que toma su lugar en las guías.
  await insumos.descontinuarProducto(id.revRevise, id.revUltra, true);

  console.log(`Seed de inventario listo: ${PRODUCTOS.length} productos, ${COMPRAS.length} compras, ${Object.keys(GUIAS).length} guías.`);
  await pool.end();
})().catch(async (err) => {
  console.error('Error en el seed de inventario:', err.message);
  await pool.end();
  process.exit(1);
});
