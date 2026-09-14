import { config } from '../config.js';
import { haversineMeters, metersToNauticalMiles } from '../lib/geo.js';
import { findSeaRoute } from './seaRoute.js';

/**
 * Huecos de cobertura AIS.
 *
 * aisstream.io es AIS terrestre: cubre bien las costas y mal el oceano abierto.
 * Un buque desaparece dias en mitad del Pacifico y reaparece al acercarse a
 * tierra. Sin tratarlo, el recorrido une esos dos puntos con una recta que
 * ademas puede cruzar tierra, y la distancia sale corta.
 *
 * Lo que hace este modulo: detectar el hueco, reconstruir por donde pudo ir el
 * buque sobre la ruta maritima, y deducir la velocidad media que eso implica.
 *
 * Lo que NO hace, y es deliberado: escribir en vessel_positions. Eso es la
 * tabla de lo observado. Una posicion inventada ahi envenenaria distancias,
 * escalas, permanencias y todo lo que se derive de ellas, sin que se vea.
 */

/** Velocidades entre las que una travesia mercante es creible, en nudos. */
export const MIN_PLAUSIBLE_SPEED_KN = 1;
export const MAX_PLAUSIBLE_SPEED_KN = 25;

export const gapMinHours = () => config.gaps.minHours;

/**
 * ¿Hay hueco de cobertura entre dos posiciones consecutivas?
 *
 * Un buque amarrado que deja de emitir no es un hueco de cobertura: no se ha
 * movido, y reconstruirle una ruta seria inventarse un viaje. Por eso, si las
 * dos posiciones caen dentro del radio del MISMO puerto, no cuenta.
 *
 * @param {import('./portIndex.js').PortIndex} portIndex
 */
export function isCoverageGap(previous, next, portIndex, minHours = gapMinHours()) {
  const seconds = (next.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000;
  if (seconds < minHours * 3600) return false;

  const a = portIndex.findEnclosing(previous.lat, previous.lon);
  const b = portIndex.findEnclosing(next.lat, next.lon);
  if (a && b && a.port.id === b.port.id) return false;

  return true;
}

/**
 * Reconstruye un hueco: por donde pudo ir el buque y a que velocidad media.
 *
 * La velocidad implicita sale de la ruta maritima, no de la linea recta: es la
 * distancia que el buque tuvo que recorrer de verdad. Con la recta saldria una
 * velocidad menor que la real, y un Panama-Shanghai parecerian 20 nudos cuando
 * fueron 14.
 *
 * @returns {{
 *   gapSeconds:number, gapDays:number, seaRouteNm:number, straightNm:number,
 *   impliedSpeedKn:number|null, plausible:boolean, reason:string|null,
 *   pathPoints:[number,number][]|null
 * }}
 */
export function reconstructGap(previous, next) {
  const gapSeconds = Math.round((next.recordedAt.getTime() - previous.recordedAt.getTime()) / 1000);
  const gapDays = Number((gapSeconds / 86_400).toFixed(2));
  const straightNm = Number(
    metersToNauticalMiles(haversineMeters(previous.lat, previous.lon, next.lat, next.lon)).toFixed(1),
  );

  let route = null;
  try {
    route = findSeaRoute(previous.lat, previous.lon, next.lat, next.lon);
  } catch {
    route = null; // la rejilla no esta generada: se degrada, no se rompe
  }

  if (!route || gapSeconds <= 0) {
    return {
      gapSeconds,
      gapDays,
      seaRouteNm: null,
      straightNm,
      impliedSpeedKn: null,
      plausible: false,
      reason: route ? 'gap_not_positive' : 'no_sea_route',
      pathPoints: null,
    };
  }

  const seaRouteNm = Number(metersToNauticalMiles(route.meters).toFixed(1));
  const impliedSpeedKn = Number((seaRouteNm / (gapSeconds / 3600)).toFixed(2));

  // Una velocidad imposible no significa "buque rapido": significa que en el
  // hueco paso algo mas. Una escala que no se detecto, un MMSI compartido o
  // suplantado, o un salto de datos. Se marca y se deja a la vista.
  let reason = null;
  if (impliedSpeedKn > MAX_PLAUSIBLE_SPEED_KN) reason = 'implied_speed_too_high';
  else if (impliedSpeedKn < MIN_PLAUSIBLE_SPEED_KN) reason = 'implied_speed_too_low';

  return {
    gapSeconds,
    gapDays,
    seaRouteNm,
    straightNm,
    impliedSpeedKn,
    plausible: reason === null,
    reason,
    pathPoints: reason === null ? route.points : null,
  };
}

/**
 * Recorre una serie de posiciones ordenadas y devuelve sus huecos reconstruidos.
 * @param {{lat:number, lon:number, recordedAt:Date}[]} positions
 */
export function findGaps(positions, portIndex, minHours = gapMinHours()) {
  const gaps = [];
  for (let i = 1; i < positions.length; i += 1) {
    const previous = positions[i - 1];
    const next = positions[i];
    if (!isCoverageGap(previous, next, portIndex, minHours)) continue;

    gaps.push({
      from: { lat: previous.lat, lon: previous.lon, at: previous.recordedAt },
      to: { lat: next.lat, lon: next.lon, at: next.recordedAt },
      ...reconstructGap(previous, next),
    });
  }
  return gaps;
}

/** Guarda los huecos reconstruidos. Idempotente por (mmsi, gap_start). */
export async function saveGaps(client, mmsi, gaps) {
  for (const gap of gaps) {
    await client.query(
      `INSERT INTO vessel_gap_segments
         (mmsi, gap_start, gap_end, gap_seconds, gap_days,
          from_lat, from_lon, to_lat, to_lon,
          straight_nm, sea_route_nm, implied_speed_kn, plausible, reason, path_points)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (mmsi, gap_start) DO UPDATE SET
         gap_end          = EXCLUDED.gap_end,
         gap_seconds      = EXCLUDED.gap_seconds,
         gap_days         = EXCLUDED.gap_days,
         to_lat           = EXCLUDED.to_lat,
         to_lon           = EXCLUDED.to_lon,
         straight_nm      = EXCLUDED.straight_nm,
         sea_route_nm     = EXCLUDED.sea_route_nm,
         implied_speed_kn = EXCLUDED.implied_speed_kn,
         plausible        = EXCLUDED.plausible,
         reason           = EXCLUDED.reason,
         path_points      = EXCLUDED.path_points`,
      [
        mmsi, gap.from.at, gap.to.at, gap.gapSeconds, gap.gapDays,
        gap.from.lat, gap.from.lon, gap.to.lat, gap.to.lon,
        gap.straightNm, gap.seaRouteNm, gap.impliedSpeedKn, gap.plausible, gap.reason,
        gap.pathPoints ? JSON.stringify(gap.pathPoints) : null,
      ],
    );
  }
  return gaps.length;
}
