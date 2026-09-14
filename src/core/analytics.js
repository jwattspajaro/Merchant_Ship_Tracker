import { query } from '../db.js';

/** Ultimos buques mercantes vistos, con su posicion mas reciente. */
export async function listVessels({ limit = 100, offset = 0, shipType = null } = {}) {
  const { rows } = await query(
    `SELECT v.mmsi, v.imo, v.name, v.ship_type_code, v.ship_type_label, v.flag, v.last_seen_at,
            p.recorded_at AS position_recorded_at, p.lat, p.lon, p.sog, p.cog, p.nav_status
       FROM vessels v
       LEFT JOIN LATERAL (
            SELECT recorded_at, lat, lon, sog, cog, nav_status
              FROM vessel_positions
             WHERE mmsi = v.mmsi
             ORDER BY recorded_at DESC
             LIMIT 1
       ) p ON TRUE
      WHERE v.ship_type_label IS NOT NULL
        AND ($3::text IS NULL OR v.ship_type_label = $3)
      ORDER BY v.last_seen_at DESC NULLS LAST
      LIMIT $1 OFFSET $2`,
    [limit, offset, shipType],
  );

  return rows.map((r) => ({
    mmsi: r.mmsi,
    imo: r.imo,
    name: r.name,
    ship_type_code: r.ship_type_code,
    ship_type_label: r.ship_type_label,
    flag: r.flag,
    last_seen_at: r.last_seen_at,
    last_position: r.position_recorded_at
      ? {
          recorded_at: r.position_recorded_at,
          lat: r.lat,
          lon: r.lon,
          sog: r.sog,
          cog: r.cog,
          nav_status: r.nav_status,
        }
      : null,
  }));
}

export async function getVessel(mmsi) {
  const { rows } = await query('SELECT * FROM vessels WHERE mmsi = $1', [mmsi]);
  return rows[0] ?? null;
}

/**
 * Escala actual (o la mas reciente ya cerrada) de un buque.
 * dwell_seconds sale de la vista port_call_durations: si la escala sigue
 * abierta, cuenta hasta now().
 */
export async function getVesselDwell(mmsi) {
  const { rows } = await query(
    `SELECT d.id, d.mmsi, d.port_id, d.call_type, d.arrived_at, d.departed_at, d.dwell_seconds,
            po.unlocode, po.name AS port_name, po.country AS port_country
       FROM port_call_durations d
       JOIN ports po ON po.id = d.port_id
      WHERE d.mmsi = $1
      ORDER BY d.arrived_at DESC
      LIMIT 1`,
    [mmsi],
  );
  return rows[0] ?? null;
}

/** Tramo en curso: el que aun no tiene destino. */
export async function getCurrentLeg(mmsi) {
  const { rows } = await query(
    `SELECT l.id, l.mmsi, l.origin_port_id, l.departed_at,
            po.unlocode AS origin_unlocode, po.name AS origin_name,
            po.lat AS origin_lat, po.lon AS origin_lon,
            EXTRACT(EPOCH FROM (now() - l.departed_at))::bigint AS elapsed_seconds
       FROM route_legs l
       LEFT JOIN ports po ON po.id = l.origin_port_id
      WHERE l.mmsi = $1 AND l.destination_port_id IS NULL
      ORDER BY l.departed_at DESC
      LIMIT 1`,
    [mmsi],
  );
  return rows[0] ?? null;
}

/**
 * Permanencia media de un puerto por tipo de escala.
 * Solo escalas cerradas: una escala abierta aun no tiene duracion final y
 * sesgaria la media hacia abajo.
 */
export async function getPortDwellStats(portId) {
  const { rows } = await query(
    `SELECT call_type,
            COUNT(*)::int              AS calls,
            AVG(dwell_seconds)         AS avg_dwell_seconds,
            MIN(dwell_seconds)         AS min_dwell_seconds,
            MAX(dwell_seconds)         AS max_dwell_seconds,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dwell_seconds) AS median_dwell_seconds
       FROM port_call_durations
      WHERE port_id = $1 AND departed_at IS NOT NULL
      GROUP BY call_type
      ORDER BY call_type`,
    [portId],
  );
  return rows;
}

export async function getPort(portId) {
  const { rows } = await query('SELECT * FROM ports WHERE id = $1', [portId]);
  return rows[0] ?? null;
}

/** Transito medio entre dos puertos concretos, sobre tramos ya cerrados. */
export async function getTransitStats(originPortId, destinationPortId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int         AS legs,
            AVG(transit_seconds)  AS avg_transit_seconds,
            MIN(transit_seconds)  AS min_transit_seconds,
            MAX(transit_seconds)  AS max_transit_seconds,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY transit_seconds) AS median_transit_seconds
       FROM route_legs
      WHERE origin_port_id = $1 AND destination_port_id = $2
        AND transit_seconds IS NOT NULL`,
    [originPortId, destinationPortId],
  );
  return rows[0];
}
