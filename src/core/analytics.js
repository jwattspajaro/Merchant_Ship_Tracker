import { query } from '../db.js';
import { config } from '../config.js';
import { haversineMeters, metersToNauticalMiles, downsampleEvenly } from '../lib/geo.js';

// Tope de filas crudas que se leen para un recorrido. A un minuto por posicion
// (el intervalo por defecto de la ingesta) 30 dias son ~43.000 filas; el tope
// deja margen y evita que una peticion con days=365 se traiga media tabla.
export const TRACK_ROW_LIMIT = 100_000;
// Puntos que se devuelven como mucho. Suficiente para dibujar un recorrido
// reconocible sin mandar megabytes al navegador.
export const TRACK_MAX_POINTS = 1000;

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
            d.draught_on_arrival, d.draught_on_departure, d.draught_delta_m,
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
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dwell_seconds) AS median_dwell_seconds,
            COUNT(*) FILTER (WHERE draught_delta_m IS NOT NULL)::int   AS calls_with_draught,
            AVG(draught_delta_m)                                       AS avg_draught_delta_m
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

/**
 * Recorrido real de un buque en una ventana de tiempo: sus posiciones crudas,
 * no una ruta estimada.
 *
 * Solo puede devolver lo que el sistema llegó a observar. Dos limites reales, y
 * ambos se informan en la respuesta en vez de disimularse:
 *  - Si la instalacion lleva menos tiempo en marcha que la ventana pedida, el
 *    recorrido empieza cuando empezo a mirar, no hace 30 dias.
 *  - Las posiciones anteriores a RAW_RETENTION_DAYS ya no estan en la tabla:
 *    la tarea de retencion las resumio y desconecto su particion.
 *
 * La distancia se calcula sobre TODAS las posiciones de la ventana; el recorte
 * a TRACK_MAX_POINTS es solo para lo que se manda al cliente. Medir sobre la
 * version recortada acortaria la distancia en cada curva.
 */
export async function getVesselTrack(mmsi, { days = 30, maxPoints = TRACK_MAX_POINTS } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const { rows } = await query(
    `SELECT lat, lon, recorded_at, sog
       FROM vessel_positions
      WHERE mmsi = $1 AND recorded_at >= $2 AND recorded_at <= $3
      ORDER BY recorded_at
      LIMIT ${TRACK_ROW_LIMIT}`,
    [mmsi, from, to],
  );

  let meters = 0;
  for (let i = 1; i < rows.length; i += 1) {
    meters += haversineMeters(
      Number(rows[i - 1].lat), Number(rows[i - 1].lon),
      Number(rows[i].lat), Number(rows[i].lon),
    );
  }

  const points = rows.map((r) => [Number(r.lat), Number(r.lon), r.recorded_at.toISOString()]);
  const track = points.length > maxPoints ? downsampleEvenly(points, maxPoints) : points;

  // Horizonte de retencion: antes de esta fecha las posiciones crudas ya no
  // tienen por que existir, aunque el buque si navegara.
  const retentionHorizon = new Date(to.getTime() - config.retention.rawRetentionDays * 86_400_000);
  const observedFrom = rows.length ? rows[0].recorded_at : null;

  return {
    window: { days, from, to },
    positions_in_window: rows.length,
    points_returned: track.length,
    downsampled: track.length < points.length,
    truncated: rows.length === TRACK_ROW_LIMIT,
    distance_nm: Number(metersToNauticalMiles(meters).toFixed(2)),
    observed_from: observedFrom,
    observed_to: rows.length ? rows.at(-1).recorded_at : null,
    // [[lat, lon, iso8601], ...]
    track,
    coverage_note: buildCoverageNote(rows.length, observedFrom, from, retentionHorizon, days),
  };
}

function buildCoverageNote(count, observedFrom, requestedFrom, retentionHorizon, days) {
  if (count === 0) {
    return `Sin posiciones guardadas en los ultimos ${days} dias para este buque. O no se ha visto en ese tiempo, o son anteriores al horizonte de retencion.`;
  }
  if (requestedFrom < retentionHorizon) {
    return `La ventana pedida se adentra mas alla del horizonte de retencion (${retentionHorizon.toISOString().slice(0, 10)}). Lo anterior a esa fecha esta resumido en vessel_daily_summary, no como posiciones.`;
  }
  // Mas de un dia de hueco al principio: el sistema aun no miraba.
  if (observedFrom && observedFrom.getTime() - requestedFrom.getTime() > 86_400_000) {
    return `El recorrido empieza el ${observedFrom.toISOString().slice(0, 10)}: no hay observaciones anteriores de este buque en la ventana pedida.`;
  }
  return null;
}

/**
 * Escalas registradas en un puerto dentro de una ventana de fechas.
 *
 * Pensado para cruzar con documentacion aduanera: una declaracion de
 * importacion trae la fecha de llegada y el puerto, pero no el buque. Esto
 * devuelve que buques estuvieron ahi en esas fechas, para poder cotejarlo con
 * el documento de transporte, que es quien si nombra la nave.
 *
 * No hace la correlacion por ti, y no puede: sin el numero de BL, varios buques
 * pueden encajar en la misma ventana. Devuelve candidatos, no respuestas.
 */
export async function getPortCalls(portId, { from, to, callType = null, limit = 500 } = {}) {
  const { rows } = await query(
    `SELECT d.id, d.mmsi, d.call_type, d.arrived_at, d.departed_at, d.dwell_seconds,
            d.draught_on_arrival, d.draught_on_departure, d.draught_delta_m,
            v.name, v.imo, v.ship_type_label, v.flag
       FROM port_call_durations d
       JOIN vessels v ON v.mmsi = d.mmsi
      WHERE d.port_id = $1
        AND d.arrived_at < $3
        AND COALESCE(d.departed_at, now()) > $2
        AND ($4::text IS NULL OR d.call_type = $4)
      ORDER BY d.arrived_at
      LIMIT $5`,
    [portId, from, to, callType, limit],
  );
  return rows;
}

/** Busca un buque por IMO, MMSI o parte del nombre. */
export async function findVessels(term, limit = 50) {
  const digits = /^\d+$/.test(term) ? Number(term) : null;
  const { rows } = await query(
    `SELECT mmsi, imo, name, ship_type_code, ship_type_label, flag, last_seen_at
       FROM vessels
      WHERE ($1::bigint IS NOT NULL AND (mmsi = $1 OR imo = $1))
         OR name ILIKE $2
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT $3`,
    [digits, `%${term}%`, limit],
  );
  return rows;
}

/**
 * Trafico observado en un puerto, agregado por periodo.
 *
 * Esta es la pieza para cruzar con estadistica aduanera: una serie de
 * declaraciones por mes (peso, valor, subpartida) frente a una serie de trafico
 * observado por mes (escalas atracadas, buques distintos, permanencia media,
 * de que puertos venian). Se correlacionan las series, no los envios.
 *
 * Lo que mide es presencia y tiempo de muelle, NO carga movida: el AIS no da
 * toneladas. Una escala atracada larga sugiere mas trabajo que una corta, y
 * nada mas.
 */
export async function getPortTraffic(portId, { from, to, bucket = 'month' } = {}) {
  const allowed = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };
  const unit = allowed[bucket];
  if (!unit) throw new Error(`bucket debe ser uno de: ${Object.keys(allowed).join(', ')}`);

  const { rows } = await query(
    `SELECT date_trunc('${unit}', c.arrived_at)        AS period,
            c.call_type,
            COUNT(*)::int                              AS calls,
            COUNT(DISTINCT c.mmsi)::int                AS vessels,
            COUNT(*) FILTER (WHERE v.ship_type_label = 'Cargo')::int  AS cargo_calls,
            COUNT(*) FILTER (WHERE v.ship_type_label = 'Tanker')::int AS tanker_calls,
            AVG(EXTRACT(EPOCH FROM (c.departed_at - c.arrived_at)))   AS avg_dwell_seconds,
            -- Proxy de carga: positivo = los buques salieron mas hundidos de
            -- lo que entraron (carga neta); negativo = descarga neta.
            COUNT(*) FILTER (WHERE c.draught_on_arrival IS NOT NULL
                               AND c.draught_on_departure IS NOT NULL)::int AS calls_with_draught,
            AVG(c.draught_on_departure - c.draught_on_arrival)         AS avg_draught_delta_m,
            COUNT(*) FILTER (WHERE c.draught_on_departure > c.draught_on_arrival)::int AS calls_loaded,
            COUNT(*) FILTER (WHERE c.draught_on_departure < c.draught_on_arrival)::int AS calls_discharged
       FROM port_calls c
       JOIN vessels v ON v.mmsi = c.mmsi
      WHERE c.port_id = $1 AND c.arrived_at >= $2 AND c.arrived_at < $3
      GROUP BY period, c.call_type
      ORDER BY period, c.call_type`,
    [portId, from, to],
  );
  return rows;
}

/**
 * De que puertos llegaron los buques que atracaron aqui, y cuantos de cada uno.
 * Con la declaracion en la mano, el pais de origen se compara contra esto.
 *
 * Solo cuenta tramos cerrados: un buque cuyo tramo de llegada nunca se cerro no
 * tiene origen conocido, y se informa aparte en `sin_origen` en vez de
 * repartirlo entre los demas.
 */
export async function getPortOrigins(portId, { from, to, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT o.id            AS origin_port_id,
            o.unlocode      AS origin_unlocode,
            o.name          AS origin_name,
            o.country       AS origin_country,
            COUNT(*)::int   AS arrivals,
            AVG(l.transit_seconds) AS avg_transit_seconds
       FROM route_legs l
       JOIN ports o ON o.id = l.origin_port_id
      WHERE l.destination_port_id = $1
        AND l.arrived_at >= $2 AND l.arrived_at < $3
      GROUP BY o.id, o.unlocode, o.name, o.country
      ORDER BY arrivals DESC
      LIMIT $4`,
    [portId, from, to, limit],
  );

  const { rows: unknown } = await query(
    `SELECT COUNT(*)::int AS n
       FROM port_calls c
      WHERE c.port_id = $1 AND c.arrived_at >= $2 AND c.arrived_at < $3
        AND NOT EXISTS (
          SELECT 1 FROM route_legs l
           WHERE l.mmsi = c.mmsi AND l.destination_port_id = $1
             AND l.arrived_at BETWEEN c.arrived_at - interval '1 hour'
                                  AND c.arrived_at + interval '1 hour')`,
    [portId, from, to],
  );

  return { origins: rows, sin_origen: unknown[0].n };
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
