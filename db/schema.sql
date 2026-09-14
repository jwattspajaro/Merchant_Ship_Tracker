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

CREATE OR REPLACE VIEW port_call_durations AS
SELECT id, mmsi, port_id, call_type, arrived_at, departed_at,
       EXTRACT(EPOCH FROM (COALESCE(departed_at, now()) - arrived_at)) AS dwell_seconds
FROM port_calls;

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

CREATE TABLE IF NOT EXISTS vessel_daily_summary (
    mmsi            BIGINT NOT NULL REFERENCES vessels(mmsi),
    summary_date    DATE NOT NULL,
    distance_nm     DOUBLE PRECISION,
    avg_sog         DOUBLE PRECISION,
    positions_count INTEGER,
    PRIMARY KEY (mmsi, summary_date)
);
