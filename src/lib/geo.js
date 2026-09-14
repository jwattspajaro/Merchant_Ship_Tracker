// Geometria esferica en la capa de aplicacion. Sin PostGIS, a proposito:
// el esquema guarda lat/lon como DOUBLE PRECISION y todo el calculo vive aqui.

export const EARTH_RADIUS_M = 6_371_008.8; // radio medio IUGG
export const METERS_PER_NM = 1852;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Distancia del gran circulo en metros (Haversine). */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const metersToNauticalMiles = (m) => m / METERS_PER_NM;

/**
 * Interpolacion sobre el gran circulo (slerp) entre dos puntos.
 * fraction 0 -> origen, 1 -> destino.
 */
export function interpolateGreatCircle(lat1, lon1, lat2, lon2, fraction) {
  const p1 = toRad(lat1);
  const l1 = toRad(lon1);
  const p2 = toRad(lat2);
  const l2 = toRad(lon2);

  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
        ),
      ),
    );

  // Puntos coincidentes: no hay circulo mayor que recorrer.
  if (d === 0) return [lat1, lon1];

  const a = Math.sin((1 - fraction) * d) / Math.sin(d);
  const b = Math.sin(fraction * d) / Math.sin(d);

  const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
  const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
  const z = a * Math.sin(p1) + b * Math.sin(p2);

  return [toDeg(Math.atan2(z, Math.hypot(x, y))), toDeg(Math.atan2(y, x))];
}

/**
 * Linea de gran circulo origen -> destino.
 * Devuelve [origen, ...intermediatePoints, destino] como [[lat, lon], ...].
 */
export function greatCirclePath(lat1, lon1, lat2, lon2, intermediatePoints = 20) {
  const steps = Math.max(1, intermediatePoints + 1);
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    points.push(interpolateGreatCircle(lat1, lon1, lat2, lon2, i / steps));
  }
  return points;
}

/** Longitud total de una polilinea [[lat, lon], ...] en metros. */
export function pathLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return total;
}

/**
 * Recorta una serie a como mucho `max` elementos, equiespaciados por indice y
 * conservando siempre el primero y el ultimo.
 */
export function downsampleEvenly(items, max) {
  if (max < 2) throw new Error('max debe ser >= 2');
  if (items.length <= max) return [...items];

  const out = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) {
    out.push(items[Math.round(i * step)]);
  }
  return out;
}
