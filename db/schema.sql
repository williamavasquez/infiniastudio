CREATE TABLE IF NOT EXISTS clientes (
  documento      TEXT PRIMARY KEY,
  tipo_doc       TEXT,
  paciente       TEXT NOT NULL,
  ruc            TEXT,
  celular        TEXT,
  distrito       TEXT,
  f_nacimiento   DATE,
  correo         TEXT,
  direccion      TEXT,
  fecha_creacion TIMESTAMPTZ
);

-- Additive migrations below are idempotent and safe to re-run against an
-- already-existing database.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS apodo TEXT;

CREATE TABLE IF NOT EXISTS asistencias (
  id            SERIAL PRIMARY KEY,
  fecha         DATE NOT NULL,
  hora_atencion TIME NOT NULL,
  turno         TEXT NOT NULL CHECK (turno IN ('Mañana', 'Tarde')),
  tipo_doc      TEXT,
  nro_doc       TEXT NOT NULL REFERENCES clientes(documento),
  paciente      TEXT NOT NULL,
  categoria     TEXT NOT NULL CHECK (categoria IN ('Asistencia Estética', 'Asistencia Pilates')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asistencias_nro_doc ON asistencias(nro_doc);
CREATE INDEX IF NOT EXISTS idx_asistencias_fecha ON asistencias(fecha);

ALTER TABLE asistencias DROP CONSTRAINT IF EXISTS asistencias_categoria_check;
ALTER TABLE asistencias ADD CONSTRAINT asistencias_categoria_check
  CHECK (categoria IN ('Asistencia Estética', 'Asistencia Pilates', 'Clase de prueba', 'Consulta Medica'));

-- Área/Servicio reemplaza el "categoria" plano de 4 valores. categoria queda
-- en la tabla solo por compatibilidad histórica; las filas nuevas no la usan.
ALTER TABLE asistencias ALTER COLUMN categoria DROP NOT NULL;
ALTER TABLE asistencias DROP CONSTRAINT IF EXISTS asistencias_categoria_check;
ALTER TABLE asistencias ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE asistencias ADD COLUMN IF NOT EXISTS servicio TEXT;
ALTER TABLE asistencias DROP CONSTRAINT IF EXISTS asistencias_area_check;
ALTER TABLE asistencias ADD CONSTRAINT asistencias_area_check
  CHECK (area IS NULL OR area IN ('Pilates', 'Estética'));

-- Sexo del cliente.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS sexo TEXT;

-- Al eliminar un cliente desde el panel admin, sus asistencias se eliminan
-- en cascada (si no, la FK impediría el borrado).
ALTER TABLE asistencias DROP CONSTRAINT IF EXISTS asistencias_nro_doc_fkey;
ALTER TABLE asistencias ADD CONSTRAINT asistencias_nro_doc_fkey
  FOREIGN KEY (nro_doc) REFERENCES clientes(documento) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Servicios (tarifario). Cada pestaña del Excel del tarifario es una
-- "categoria" (Estética / Pilates / Tienda Infinia) y "familia" es el
-- subgrupo dentro de esa categoría. El SKU es el id del servicio.
--
-- Antes esta tabla se llamaba `productos`; "productos" ahora es el inventario.
-- El renombre corre una sola vez (solo si `productos` existe y `servicios` no)
-- y va ANTES del CREATE TABLE para que en una base existente no se cree una
-- tabla vacía al lado. En una base nueva no hace nada.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.productos') IS NOT NULL AND to_regclass('public.servicios') IS NULL THEN
    ALTER TABLE productos RENAME TO servicios;
    ALTER INDEX IF EXISTS productos_pkey RENAME TO servicios_pkey;
    ALTER INDEX IF EXISTS idx_productos_categoria RENAME TO idx_servicios_categoria;
    ALTER INDEX IF EXISTS idx_productos_familia RENAME TO idx_servicios_familia;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS servicios (
  sku             TEXT PRIMARY KEY,
  categoria       TEXT NOT NULL,
  familia         TEXT,
  nombre          TEXT NOT NULL,
  precio_regular  NUMERIC(10, 2),
  precio_oferta   NUMERIC(10, 2),
  precio_max_desc NUMERIC(10, 2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_servicios_categoria ON servicios(categoria);
CREATE INDEX IF NOT EXISTS idx_servicios_familia ON servicios(familia);

-- ---------------------------------------------------------------------------
-- Cotizaciones. Un cliente puede tener muchas.
--
-- `estado` guarda solo lo que se decide a mano: una cotización nace 'abierta'
-- y alguien la marca 'aceptada' o 'rechazada'. El semáforo (caliente / tibio /
-- frío / vencida) NO se guarda: se deriva de la antigüedad de `updated_at`
-- al consultar, así nunca queda desactualizado. Cualquier edición —incluida
-- una nota nueva— toca `updated_at` y reinicia el reloj.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cotizaciones (
  id           SERIAL PRIMARY KEY,
  numero       TEXT NOT NULL UNIQUE,
  documento    TEXT NOT NULL REFERENCES clientes(documento) ON DELETE CASCADE,
  titulo       TEXT,
  estado       TEXT NOT NULL DEFAULT 'abierta'
               CHECK (estado IN ('abierta', 'aceptada', 'rechazada')),
  validez_dias INTEGER NOT NULL DEFAULT 30,
  observaciones TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cotizaciones_documento ON cotizaciones(documento);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_updated_at ON cotizaciones(updated_at);

-- El nombre y el precio del ítem se congelan al cotizar: si después cambia el
-- tarifario, la cotización que ya se le mandó al cliente no se altera. Por eso
-- `sku` no tiene FK dura contra servicios (un servicio puede borrarse y la
-- cotización histórica tiene que sobrevivir).
CREATE TABLE IF NOT EXISTS cotizacion_items (
  id              SERIAL PRIMARY KEY,
  cotizacion_id   INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  sku             TEXT,
  nombre          TEXT NOT NULL,
  cantidad        INTEGER NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  precio_unitario NUMERIC(10, 2) NOT NULL CHECK (precio_unitario >= 0),
  tipo_precio     TEXT,
  orden           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cotizacion_items_cotizacion ON cotizacion_items(cotizacion_id);

CREATE TABLE IF NOT EXISTS cotizacion_notas (
  id            SERIAL PRIMARY KEY,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  texto         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cotizacion_notas_cotizacion ON cotizacion_notas(cotizacion_id);

-- Registro de envíos por correo, para saber si al cliente ya se le mandó.
CREATE TABLE IF NOT EXISTS cotizacion_envios (
  id            SERIAL PRIMARY KEY,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  destinatario  TEXT NOT NULL,
  enviado_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cotizacion_envios_cotizacion ON cotizacion_envios(cotizacion_id);

-- ---------------------------------------------------------------------------
-- Aceptación parcial: cada ítem se acepta/rechaza por separado (ej. el
-- cliente acepta un servicio hoy y deja los otros dos en seguimiento). El
-- estado de la cotización completa (`cotizaciones.estado`) deja de setearse a
-- mano: de acá en más se deriva de estos estados al consultar (ver
-- ESTADO_ITEMS_SQL en cotizacionesRepo.js) — 'abierta' si todos están
-- pendientes, 'aceptada'/'rechazada' si todos coinciden, 'parcial' si están
-- mezclados. La columna `cotizaciones.estado` queda en la tabla solo por
-- compatibilidad histórica (nunca más se escribe).
--
-- El bloque está envuelto en un IF para que el backfill (heredar la decisión
-- ya tomada a mano en `cotizaciones.estado` hacia los ítems) corra una sola
-- vez: si corriera de nuevo en un deploy futuro, forzaría a 'aceptado' un
-- ítem nuevo agregado después a una cotización vieja que ya estaba aceptada.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cotizacion_items' AND column_name = 'estado'
  ) THEN
    ALTER TABLE cotizacion_items ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendiente';
    ALTER TABLE cotizacion_items ADD CONSTRAINT cotizacion_items_estado_check
      CHECK (estado IN ('pendiente', 'aceptado', 'rechazado'));

    UPDATE cotizacion_items ci SET estado = 'aceptado'
      FROM cotizaciones c WHERE c.id = ci.cotizacion_id AND c.estado = 'aceptada';
    UPDATE cotizacion_items ci SET estado = 'rechazado'
      FROM cotizaciones c WHERE c.id = ci.cotizacion_id AND c.estado = 'rechazada';
  END IF;
END $$;

-- Historial de cambios de una cotización (ítems agregados/editados/quitados,
-- cambios de estado por ítem): una línea de tiempo tipo "actividad de Jira"
-- que se muestra junto a las notas manuales.
CREATE TABLE IF NOT EXISTS cotizacion_historial (
  id            SERIAL PRIMARY KEY,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL,
  detalle       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cotizacion_historial_cotizacion ON cotizacion_historial(cotizacion_id);

-- ---------------------------------------------------------------------------
-- Cuentas del panel admin, con roles y permisos por módulo.
--
-- `es_admin` marca el rol "Admin" (dios): siempre tiene todos los permisos en
-- true y no se puede borrar ni editar sus permisos (ver usuariosRepo.js). Los
-- demás roles son los que el admin crea desde /admin/cuentas, con los
-- permisos que decida por módulo — incluido "servicios", que arranca sin
-- concederse a ningún rol nuevo pero no está bloqueado a nivel de esquema.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL UNIQUE,
  es_admin   BOOLEAN NOT NULL DEFAULT false,
  permisos   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  activo        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_rol ON usuarios(rol_id);

-- El rol Admin (dios) siempre existe y siempre tiene todos los permisos. Se crea
-- acá (idempotente) para que exista antes de que arranque el server y pueda
-- bootstrapear la primera cuenta admin.
-- `permisos.precios` controla, dentro de Cotizaciones, cuáles de los 3
-- niveles de precio del tarifario puede ver/elegir el rol al agregar un
-- ítem (algunos precios —el de máximo descuento— solo se habilitan con
-- aprobación, y no todos los roles de ventas deberían verlos).
INSERT INTO roles (nombre, es_admin, permisos)
VALUES ('Admin', true, '{"clientes":true,"asistencias":true,"servicios":true,"inventario":true,"cotizaciones":true,"cuentas":true,"precios":{"regular":true,"oferta":true,"max_desc":true}}'::jsonb)
ON CONFLICT (nombre) DO UPDATE SET es_admin = true,
  permisos = '{"clientes":true,"asistencias":true,"servicios":true,"inventario":true,"cotizaciones":true,"cuentas":true,"precios":{"regular":true,"oferta":true,"max_desc":true}}'::jsonb;

-- El permiso `productos` (tarifario) pasó a llamarse `servicios`. Se migra la
-- clave dentro del JSONB de cada rol; es idempotente (solo toca roles que
-- todavía tienen la clave vieja).
UPDATE roles SET permisos = (permisos - 'productos') || jsonb_build_object('servicios', permisos->'productos')
WHERE permisos ? 'productos';

-- ---------------------------------------------------------------------------
-- Inventario. "Servicios" es el tarifario (lo que se cobra); el inventario es
-- lo que se compra y se consume: insumos de estética (botox, cremas) y los
-- artículos de la Tienda Infinia (mats, toallas, medias).
--
-- El stock se guarda en la unidad base (ml, unidad, par...) aunque se compre
-- en otra (caja de 12, frasco de 500 ml): `factor` = unidades base por unidad
-- de compra. No hay columna de stock: es SUM(movimientos.cantidad).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proveedores (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  ruc        TEXT,
  contacto   TEXT,
  telefono   TEXT,
  correo     TEXT,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dos niveles: parent_id NULL = categoría, parent_id = id de una categoría
-- = familia. Se desactivan en vez de borrarse (los productos las referencian).
CREATE TABLE IF NOT EXISTS inventario_categorias (
  id        SERIAL PRIMARY KEY,
  nombre    TEXT NOT NULL,
  parent_id INTEGER REFERENCES inventario_categorias(id) ON DELETE RESTRICT,
  activo    BOOLEAN NOT NULL DEFAULT true
);

-- El SKU de un artículo de tienda es el mismo SKU del servicio que lo vende
-- (TIEFOR0001); el de un insumo sale del mismo generador prefijo+correlativo.
-- No cambia nunca, ni al recategorizar. `categoria_id` apunta a la familia, o
-- a la categoría si no tiene familia. Costos en soles, IGV incluido;
-- `costo_promedio` es por unidad base (promedio móvil ponderado).
CREATE TABLE IF NOT EXISTS inventario (
  id               SERIAL PRIMARY KEY,
  sku              TEXT NOT NULL UNIQUE,
  nombre           TEXT NOT NULL,
  descripcion      TEXT,
  categoria_id     INTEGER REFERENCES inventario_categorias(id) ON DELETE RESTRICT,
  unidad_base      TEXT NOT NULL DEFAULT 'unidad',
  unidad_compra    TEXT NOT NULL DEFAULT 'unidad',
  factor           NUMERIC(14, 4) NOT NULL DEFAULT 1 CHECK (factor > 0),
  stock_minimo     NUMERIC(14, 4) CHECK (stock_minimo >= 0),
  costo_promedio   NUMERIC(14, 6) NOT NULL DEFAULT 0,
  discontinuado_at TIMESTAMPTZ,
  reemplazado_por  INTEGER REFERENCES inventario(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventario_categoria ON inventario(categoria_id);

-- Un producto puede llamarse distinto en cada proveedor (y tener varios
-- códigos con el mismo). sku_proveedor puede quedar vacío (NULL).
CREATE TABLE IF NOT EXISTS inventario_skus_proveedor (
  id            SERIAL PRIMARY KEY,
  producto_id   INTEGER NOT NULL REFERENCES inventario(id) ON DELETE CASCADE,
  proveedor_id  INTEGER NOT NULL REFERENCES proveedores(id) ON DELETE RESTRICT,
  sku_proveedor TEXT,
  UNIQUE (proveedor_id, sku_proveedor)
);

CREATE INDEX IF NOT EXISTS idx_inv_skus_prov_producto ON inventario_skus_proveedor(producto_id);

-- Libro de movimientos: solo se agrega, nunca se edita ni se borra. `cantidad`
-- va con signo, en unidad base. Un error se corrige con otro movimiento.
CREATE TABLE IF NOT EXISTS movimientos (
  id             SERIAL PRIMARY KEY,
  producto_id    INTEGER NOT NULL REFERENCES inventario(id) ON DELETE RESTRICT,
  tipo           TEXT NOT NULL
                 CHECK (tipo IN ('conteo_inicial', 'compra', 'consumo', 'ajuste', 'anulacion')),
  cantidad       NUMERIC(14, 4) NOT NULL,
  costo_unitario NUMERIC(14, 6),
  motivo         TEXT,
  ref_tipo       TEXT,
  ref_id         INTEGER,
  usuario_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos(producto_id, created_at);
