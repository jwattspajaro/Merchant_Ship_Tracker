import { downsampleEvenly } from '../lib/geo.js';

// Cuantos puntos como maximo se guardan en route_legs.path_points. Las
// posiciones crudas siguen en vessel_positions; esto es solo la traza recortada
// para dibujar el tramo sin leer la tabla grande.
export const MAX_PATH_POINTS = 60;

/**
 * Maquina de estados de escalas y tramos (seccion 4.2).
 *
 * Por cada posicion nueva de un buque ya confirmado como mercante:
 *   1. Si hay escala abierta y la posicion cae FUERA del radio de ESE puerto:
 *      se cierra la escala y se abre un tramo con ese puerto como origen.
 *   2. Si hay tramo abierto y la posicion cae DENTRO del radio de un puerto:
 *      se cierra el tramo (destino, transit_seconds y path_points).
 *   3. Si no hay escala abierta y la posicion cae dentro del radio de un puerto:
 *      se abre una escala, clasificada como 'berth' o 'anchorage'.
 *
 * Debe llamarse en serie por buque: dos posiciones del mismo MMSI en paralelo
 * competirian por el mismo estado. La ingesta procesa secuencialmente.
 *
 * @param {import('pg').PoolClient} client cliente dentro de una transaccion
 * @param {import('./portIndex.js').PortIndex} portIndex
 * @param {{mmsi:number, recordedAt:Date, lat:number, lon:number,
 *          sog:number|null, cog:number|null, navStatus:string|null}} position
 */
export async function processPosition(client, portIndex, position) {
  const { mmsi, recordedAt, lat, lon, sog = null, cog = null, navStatus = null } = position;
  const events = [];

  const inserted = await client.query(
    `INSERT INTO vessel_positions (mmsi, recorded_at, lat, lon, sog, cog, nav_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [mmsi, recordedAt, lat, lon, sog, cog, navStatus],
  );

  await client.query(
    `UPDATE vessels SET last_seen_at = $2
     WHERE mmsi = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)`,
    [mmsi, recordedAt],
  );

  const match = portIndex.findEnclosing(lat, lon);
  let openCall = await findOpenCall(client, mmsi);
  let openLeg = await findOpenLeg(client, mmsi);

  // 1. Salida de puerto: habia escala y ya no estamos en ESE puerto.
  if (openCall && (!match || match.port.id !== openCall.port_id)) {
    if (openLeg) {
      throw new Error(
        `Estado inconsistente para MMSI ${mmsi}: escala ${openCall.id} y tramo ${openLeg.id} abiertos a la vez`,
      );
    }
    await client.query(
      `UPDATE port_calls SET departed_at = $2, draught_on_departure = $3 WHERE id = $1`,
      [openCall.id, recordedAt, await draughtAt(client, mmsi, recordedAt)],
    );
    events.push({ type: 'port_call_closed', portCallId: openCall.id, portId: openCall.port_id });

    const legRow = await client.query(
      `INSERT INTO route_legs (mmsi, origin_port_id, departed_at)
       VALUES ($1, $2, $3) RETURNING *`,
      [mmsi, openCall.port_id, recordedAt],
    );
    openLeg = legRow.rows[0];
    openCall = null;
    events.push({ type: 'route_leg_opened', routeLegId: openLeg.id, originPortId: openLeg.origin_port_id });
  }

  // 2. Llegada: habia tramo abierto y la posicion entra al radio de un puerto.
  if (match && openLeg) {
    const closed = await closeRouteLeg(client, openLeg, match.port.id, recordedAt);
    openLeg = null;
    events.push({
      type: 'route_leg_closed',
      routeLegId: closed.id,
      destinationPortId: closed.destination_port_id,
      transitSeconds: closed.transit_seconds,
      pathPoints: closed.path_points?.length ?? 0,
    });
  }

  // 3. Entrada a puerto sin escala abierta.
  if (match && !openCall) {
    const callRow = await client.query(
      `INSERT INTO port_calls (mmsi, port_id, call_type, arrived_at, draught_on_arrival)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [mmsi, match.port.id, match.callType, recordedAt, await draughtAt(client, mmsi, recordedAt)],
    );
    openCall = callRow.rows[0];
    events.push({
      type: 'port_call_opened',
      portCallId: openCall.id,
      portId: openCall.port_id,
      callType: openCall.call_type,
      distanceM: Math.round(match.distanceM),
    });
  }

  return {
    positionId: inserted.rows[0].id,
    port: match ? match.port : null,
    distanceM: match ? match.distanceM : null,
    openCall,
    openLeg,
    events,
  };
}

/**
 * Ultimo calado declarado por el buque en o antes de ese instante.
 *
 * Se mira hacia atras, nunca hacia delante: al abrir la escala interesa como
 * venia el buque, no como se fue. Devuelve null si el buque nunca ha declarado
 * calado, que es lo normal hasta que llega su primer ShipStaticData.
 */
export async function draughtAt(client, mmsi, at) {
  const { rows } = await client.query(
    `SELECT draught_m FROM vessel_draught_reports
      WHERE mmsi = $1 AND reported_at <= $2
      ORDER BY reported_at DESC LIMIT 1`,
    [mmsi, at],
  );
  return rows[0]?.draught_m ?? null;
}

export async function findOpenCall(client, mmsi) {
  const { rows } = await client.query(
    'SELECT * FROM port_calls WHERE mmsi = $1 AND departed_at IS NULL ORDER BY arrived_at DESC LIMIT 1',
    [mmsi],
  );
  return rows[0] ?? null;
}

export async function findOpenLeg(client, mmsi) {
  const { rows } = await client.query(
    'SELECT * FROM route_legs WHERE mmsi = $1 AND destination_port_id IS NULL ORDER BY departed_at DESC LIMIT 1',
    [mmsi],
  );
  return rows[0] ?? null;
}

/**
 * Cierra un tramo: fija destino y duracion real, y reconstruye la traza a
 * partir de las posiciones guardadas en la ventana del tramo.
 */
export async function closeRouteLeg(client, leg, destinationPortId, arrivedAt) {
  const transitSeconds = Math.round((arrivedAt.getTime() - new Date(leg.departed_at).getTime()) / 1000);
  const pathPoints = await buildPathPoints(client, leg.mmsi, leg.departed_at, arrivedAt);

  const { rows } = await client.query(
    `UPDATE route_legs
        SET destination_port_id = $2, arrived_at = $3, transit_seconds = $4, path_points = $5
      WHERE id = $1
      RETURNING *`,
    [leg.id, destinationPortId, arrivedAt, transitSeconds, JSON.stringify(pathPoints)],
  );
  return rows[0];
}

/** [[lat, lon, iso8601], ...] recortado a MAX_PATH_POINTS puntos equiespaciados. */
export async function buildPathPoints(client, mmsi, fromTs, toTs) {
  const { rows } = await client.query(
    `SELECT lat, lon, recorded_at
       FROM vessel_positions
      WHERE mmsi = $1 AND recorded_at >= $2 AND recorded_at <= $3
      ORDER BY recorded_at`,
    [mmsi, fromTs, toTs],
  );
  const points = rows.map((r) => [Number(r.lat), Number(r.lon), r.recorded_at.toISOString()]);
  return points.length <= MAX_PATH_POINTS ? points : downsampleEvenly(points, MAX_PATH_POINTS);
}
