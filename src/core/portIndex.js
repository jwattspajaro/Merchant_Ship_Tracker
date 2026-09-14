import { haversineMeters } from '../lib/geo.js';
import { query } from '../db.js';

// Fraccion del radio de aproximacion por debajo de la cual se considera que el
// buque esta atracado y no fondeado (seccion 4.2 de la especificacion).
export const BERTH_RADIUS_FRACTION = 0.30;

/**
 * Indice de puertos en memoria. La lista completa de puertos del mundo son unos
 * pocos miles de filas: cabe entera en RAM y evita una consulta por posicion.
 *
 * Prefiltro por franja de latitud (cubos de 1 grado) para no recorrer todos los
 * puertos en cada posicion. La longitud no se indexa a proposito: asi no hay que
 * tratar el cruce del antimeridiano como caso especial.
 */
export class PortIndex {
  constructor(ports) {
    this.ports = ports.map((p) => ({
      id: p.id,
      unlocode: p.unlocode,
      name: p.name,
      country: p.country,
      lat: Number(p.lat),
      lon: Number(p.lon),
      approach_radius_m: Number(p.approach_radius_m),
    }));

    this.byId = new Map(this.ports.map((p) => [p.id, p]));

    // Un puerto entra en todos los cubos de latitud que su radio pueda alcanzar.
    this.latBuckets = new Map();
    for (const port of this.ports) {
      const latSpanDeg = port.approach_radius_m / 111_320;
      const from = Math.floor(port.lat - latSpanDeg);
      const to = Math.floor(port.lat + latSpanDeg);
      for (let b = from; b <= to; b += 1) {
        if (!this.latBuckets.has(b)) this.latBuckets.set(b, []);
        this.latBuckets.get(b).push(port);
      }
    }
  }

  get size() {
    return this.ports.length;
  }

  getById(id) {
    return this.byId.get(Number(id)) ?? null;
  }

  /**
   * Puerto cuyo radio de aproximacion contiene el punto. Si varios lo contienen
   * (radios solapados), gana el de centroide mas cercano.
   *
   * @returns {{port: object, distanceM: number, callType: 'berth'|'anchorage'}|null}
   */
  findEnclosing(lat, lon) {
    const candidates = this.latBuckets.get(Math.floor(lat));
    if (!candidates) return null;

    let best = null;
    for (const port of candidates) {
      const distanceM = haversineMeters(lat, lon, port.lat, port.lon);
      if (distanceM > port.approach_radius_m) continue;
      if (best === null || distanceM < best.distanceM) {
        best = { port, distanceM, callType: classifyCall(distanceM, port.approach_radius_m) };
      }
    }
    return best;
  }

  /** Distancia al centroide de un puerto concreto, en metros. */
  distanceToPort(lat, lon, portId) {
    const port = this.getById(portId);
    if (!port) return null;
    return haversineMeters(lat, lon, port.lat, port.lon);
  }

  /** ¿Sigue el punto dentro del radio de ESE puerto? */
  isWithinPort(lat, lon, portId) {
    const port = this.getById(portId);
    if (!port) return false;
    return haversineMeters(lat, lon, port.lat, port.lon) <= port.approach_radius_m;
  }
}

/**
 * Muy cerca del centroide -> atracado (probablemente trabajando).
 * Dentro del radio pero lejos del centroide -> fondeado (probablemente esperando turno).
 */
export function classifyCall(distanceM, approachRadiusM) {
  return distanceM < BERTH_RADIUS_FRACTION * approachRadiusM ? 'berth' : 'anchorage';
}

export async function loadPortIndex(client = null) {
  const runner = client ?? { query };
  const { rows } = await runner.query(
    'SELECT id, unlocode, name, country, lat, lon, approach_radius_m FROM ports',
  );
  return new PortIndex(rows);
}
