-- Merchant Ship Tracker - esquema base (PostgreSQL 13+)
-- Sin extensiones obligatorias: lat/lon en DOUBLE PRECISION y Haversine en la
-- capa de aplicacion. PostGIS queda como mejora futura opcional (poligonos de
-- puerto reales en lugar de un radio), fuera de este alcance.

CREATE TABLE IF NOT EXISTS vessels (
    mmsi            BIGINT PRIMARY KEY,
    imo             BIGINT,
    name            TEXT,
    ship_type_code  INTEGER,        -- codigo crudo AIS (ITU-R M.1371)
    ship_type_label TEXT,           -- 'Cargo', 'Tanker'
    flag            TEXT,
    last_seen_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ports (
    id                 SERIAL PRIMARY KEY,
    unlocode           TEXT UNIQUE,
    name               TEXT NOT NULL,
    country            TEXT,
    lat                DOUBLE PRECISION NOT NULL,
    lon                DOUBLE PRECISION NOT NULL,
    approach_radius_m  INTEGER NOT NULL DEFAULT 8000
);
CREATE INDEX IF NOT EXISTS idx_ports_lat_lon ON ports (lat, lon);

CREATE TABLE IF NOT EXISTS vessel_positions (
    id           BIGSERIAL,
    mmsi         BIGINT NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL,
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL,
    sog          DOUBLE PRECISION,
    cog          DOUBLE PRECISION,
    nav_status   TEXT,
    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);
-- Las particiones mensuales (mes en curso + los dos siguientes) las crea
-- scripts/migrate.js y las mantiene la tarea diaria: src/jobs/partitions.js
CREATE INDEX IF NOT EXISTS idx_vessel_positions_mmsi_time
    ON vessel_positions (mmsi, recorded_at DESC);

CREATE TABLE IF NOT EXISTS port_calls (
    id           BIGSERIAL PRIMARY KEY,
    mmsi         BIGINT NOT NULL REFERENCES vessels(mmsi),
    port_id      INTEGER NOT NULL REFERENCES ports(id),
    call_type    TEXT NOT NULL CHECK (call_type IN ('anchorage', 'berth')),
    arrived_at   TIMESTAMPTZ NOT NULL,
    departed_at  TIMESTAMPTZ          -- NULL mientras el buque sigue ahi
);
CREATE INDEX IF NOT EXISTS idx_port_calls_mmsi ON port_calls (mmsi);
CREATE INDEX IF NOT EXISTS idx_port_calls_port ON port_calls (port_id);
-- Un buque no puede tener dos escalas abiertas a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_port_calls_one_open_per_vessel
    ON port_calls (mmsi) WHERE departed_at IS NULL;

-- La vista port_call_durations se define mas abajo, una sola vez y despues de
-- que los ALTER TABLE hayan creado las columnas de calado. Definirla dos veces
-- rompe la migracion: CREATE OR REPLACE VIEW no puede quitar columnas, asi que
-- al reaplicar el esquema sobre una base ya migrada fallaba.

CREATE TABLE IF NOT EXISTS route_legs (
    id                    BIGSERIAL PRIMARY KEY,
    mmsi                  BIGINT NOT NULL REFERENCES vessels(mmsi),
    origin_port_id        INTEGER REFERENCES ports(id),
    destination_port_id   INTEGER REFERENCES ports(id),
    departed_at           TIMESTAMPTZ NOT NULL,
    arrived_at            TIMESTAMPTZ,
    transit_seconds       INTEGER,
    path_points           JSONB      -- [[lat,lon,timestamp], ...] recortado a ~60 puntos
);
CREATE INDEX IF NOT EXISTS idx_route_legs_ports
    ON route_legs (origin_port_id, destination_port_id);
-- Un buque no puede tener dos tramos abiertos a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_route_legs_one_open_per_vessel
    ON route_legs (mmsi) WHERE destination_port_id IS NULL;

-- ---------------------------------------------------------------------------
-- Calado (seccion 4.3, ampliacion posterior)
--
-- El AIS SI transmite el calado maximo estatico, en ShipStaticData, y el calado
-- cambia entre cargado y en lastre. La diferencia de calado entre la llegada y
-- la salida de una escala atracada es el mejor indicador de carga que se puede
-- sacar del AIS.
--
-- Sigue siendo una INFERENCIA, no una medida, y por tres motivos concretos:
--   1. Lo teclea la tripulacion a mano. Se queda desactualizado, o mal puesto.
--   2. Viene redondeado a 0,1 m.
--   3. De metros a toneladas hace falta la tabla hidrostatica del buque (TPC),
--      que el AIS no da. Sin ella hay direccion y magnitud relativa, no tonelaje.
--
-- Por eso vive en su propia tabla y no se mezcla con lo observado sin adornos.
CREATE TABLE IF NOT EXISTS vessel_draught_reports (
    mmsi         BIGINT NOT NULL REFERENCES vessels(mmsi),
    reported_at  TIMESTAMPTZ NOT NULL,
    draught_m    DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (mmsi, reported_at)
);
CREATE INDEX IF NOT EXISTS idx_draught_mmsi_time
    ON vessel_draught_reports (mmsi, reported_at DESC);

ALTER TABLE vessels    ADD COLUMN IF NOT EXISTS draught_m            DOUBLE PRECISION;
ALTER TABLE port_calls ADD COLUMN IF NOT EXISTS draught_on_arrival   DOUBLE PRECISION;
ALTER TABLE port_calls ADD COLUMN IF NOT EXISTS draught_on_departure DOUBLE PRECISION;

-- Ahora que port_calls tiene las columnas de calado, la vista las publica junto
-- con la diferencia. Positiva = el buque salio mas hundido (cargo neto);
-- negativa = salio mas ligero (descargo neto).
CREATE OR REPLACE VIEW port_call_durations AS
SELECT id, mmsi, port_id, call_type, arrived_at, departed_at,
       EXTRACT(EPOCH FROM (COALESCE(departed_at, now()) - arrived_at)) AS dwell_seconds,
       draught_on_arrival,
       draught_on_departure,
       draught_on_departure - draught_on_arrival AS draught_delta_m
FROM port_calls;

-- ---------------------------------------------------------------------------
-- Huecos de cobertura AIS (fase B del plan)
--
-- Cuando un buque deja de emitir y reaparece lejos, aqui se guarda por donde
-- pudo ir y a que velocidad media. Tabla APARTE a proposito: esto es estimado,
-- y vessel_positions es la tabla de lo observado. Mezclarlos envenenaria
-- distancias, escalas y permanencias sin que se viera.
CREATE TABLE IF NOT EXISTS vessel_gap_segments (
    mmsi             BIGINT NOT NULL REFERENCES vessels(mmsi),
    gap_start        TIMESTAMPTZ NOT NULL,
    gap_end          TIMESTAMPTZ NOT NULL,
    gap_seconds      INTEGER NOT NULL,
    gap_days         DOUBLE PRECISION NOT NULL,
    from_lat         DOUBLE PRECISION NOT NULL,
    from_lon         DOUBLE PRECISION NOT NULL,
    to_lat           DOUBLE PRECISION NOT NULL,
    to_lon           DOUBLE PRECISION NOT NULL,
    straight_nm      DOUBLE PRECISION,
    sea_route_nm     DOUBLE PRECISION,
    implied_speed_kn DOUBLE PRECISION,
    plausible        BOOLEAN NOT NULL DEFAULT FALSE,
    reason           TEXT,
    path_points      JSONB,
    PRIMARY KEY (mmsi, gap_start)
);
CREATE INDEX IF NOT EXISTS idx_gap_mmsi_start ON vessel_gap_segments (mmsi, gap_start DESC);

CREATE TABLE IF NOT EXISTS vessel_daily_summary (
    mmsi            BIGINT NOT NULL REFERENCES vessels(mmsi),
    summary_date    DATE NOT NULL,
    distance_nm     DOUBLE PRECISION,
    avg_sog         DOUBLE PRECISION,
    positions_count INTEGER,
    PRIMARY KEY (mmsi, summary_date)
);
