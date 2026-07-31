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
