import { query } from '../db.js';
import { greatCirclePath } from '../lib/geo.js';
import { getPort, getTransitStats } from './analytics.js';

// Numero minimo de tramos historicos cerrados para el mismo par de puertos a
// partir del cual la ruta se considera "aprendida" (seccion 4.5).
export const MIN_LEGS_FOR_HISTORICAL = 3;
export const GREAT_CIRCLE_INTERMEDIATE_POINTS = 20;

/**
 * Ruta estimada entre dos puertos.
 *
 * Con >= 3 tramos cerrados para ese par exacto se devuelve la traza real del
 * tramo cuya duracion es la mas cercana a la mediana ("el mas tipico"), no un
 * promedio de trazas: promediar caminos produce rutas que ningun buque hizo.
 *
 * Con menos de 3 se devuelve una linea de gran circulo entre centroides, sin
 * duracion estimada -- todavia no hay con que estimarla.
 */
export async function estimateRoute(originPortId, destinationPortId) {
  const [origin, destination] = await Promise.all([
    getPort(originPortId),
    getPort(destinationPortId),
  ]);
  if (!origin || !destination) return null;

  const { rows: legs } = await query(
    `SELECT id, mmsi, departed_at, arrived_at, transit_seconds, path_points
       FROM route_legs
      WHERE origin_port_id = $1 AND destination_port_id = $2
        AND transit_seconds IS NOT NULL
      ORDER BY transit_seconds`,
    [originPortId, destinationPortId],
  );

  const usable = legs.filter((l) => Array.isArray(l.path_points) && l.path_points.length > 0);
  const stats = await getTransitStats(originPortId, destinationPortId);

  const base = {
    origin: portSummary(origin),
    destination: portSummary(destination),
    transit_stats: {
      legs: stats.legs,
      avg_transit_seconds: stats.avg_transit_seconds,
      min_transit_seconds: stats.min_transit_seconds,
      max_transit_seconds: stats.max_transit_seconds,
      median_transit_seconds: stats.median_transit_seconds,
    },
  };

  if (usable.length >= MIN_LEGS_FOR_HISTORICAL) {
    const typical = pickMostTypicalLeg(usable);
    return {
      ...base,
      source: 'historical',
      legs_considered: usable.length,
      // path_points: [[lat, lon, iso8601], ...] -- traza real de un tramo concreto.
      path_points: typical.path_points,
      transit_seconds: typical.transit_seconds,
      based_on_leg: {
        id: typical.id,
        mmsi: typical.mmsi,
        departed_at: typical.departed_at,
        arrived_at: typical.arrived_at,
      },
    };
  }

  return {
    ...base,
    source: 'great_circle',
    legs_considered: usable.length,
    // path_points: [[lat, lon], ...] -- sin marca de tiempo: es una linea
    // geometrica, no un recorrido observado.
    path_points: greatCirclePath(
      origin.lat,
      origin.lon,
      destination.lat,
      destination.lon,
      GREAT_CIRCLE_INTERMEDIATE_POINTS,
    ),
    transit_seconds: null,
    transit_note: `Sin duracion estimada: hacen falta ${MIN_LEGS_FOR_HISTORICAL} tramos historicos cerrados para este par de puertos y hay ${usable.length}.`,
  };
}

/** El tramo cuya duracion mas se acerca a la mediana del conjunto. */
export function pickMostTypicalLeg(legsSortedByTransit) {
  const median = medianOf(legsSortedByTransit.map((l) => l.transit_seconds));
  let best = legsSortedByTransit[0];
  let bestDelta = Math.abs(best.transit_seconds - median);
  for (const leg of legsSortedByTransit) {
    const delta = Math.abs(leg.transit_seconds - median);
    if (delta < bestDelta) {
      best = leg;
      bestDelta = delta;
    }
  }
  return best;
}

export function medianOf(sortedNumbers) {
  const n = sortedNumbers.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedNumbers[mid] : (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2;
}

function portSummary(p) {
  return { id: p.id, unlocode: p.unlocode, name: p.name, country: p.country, lat: p.lat, lon: p.lon };
}
