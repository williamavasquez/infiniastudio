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
-- Productos (tarifario). Cada pestaña del Excel del tarifario es una
-- "categoria" (Estética / Pilates / Tienda Infinia) y "familia" es el
-- subgrupo dentro de esa categoría. El SKU es el id del producto.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS productos (
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

CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(categoria);
CREATE INDEX IF NOT EXISTS idx_productos_familia ON productos(familia);

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
-- `sku` no tiene FK dura contra productos (un producto puede borrarse y la
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
