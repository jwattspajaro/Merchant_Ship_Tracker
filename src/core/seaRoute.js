import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { haversineMeters } from '../lib/geo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GRID_PATH = join(root, 'data', 'sea-grid.bin');
const GRID_MAGIC = 'MSTSEA01';

/**
 * Latitud maxima por la que se permite enrutar.
 *
 * Por encima esta el Artico: es agua, y la rejilla no sabe nada de hielo, asi
 * que sin limite el camino mas corto de Rotterdam a Singapur sale por la Ruta
 * del Mar del Norte (9.100 millas en vez de las 8.300 por Suez). Es navegable
 * en verano y con rompehielos, pero no es por donde va el trafico mercante, y
 * devolverla por defecto enganaria mas de lo que ayuda.
 *
 * 70 grados deja fuera esa ruta y mantiene el Baltico, el Mar del Norte,
 * Islandia, Alaska y el norte de Noruega (Murmansk esta a 68,97). Sube el
 * limite con SEA_ROUTE_MAX_LAT si de verdad quieres rutas articas.
 *
 * Lo que este enrutador NO modela, y conviene tener presente: hielo y
 * estacionalidad, calado, restricciones y peajes de canal, zonas de guerra o
 * pirateria, y separacion de trafico. Devuelve un camino navegable por
 * geometria, no un plan de viaje.
 */
export const MAX_ROUTING_LATITUDE = Number(process.env.SEA_ROUTE_MAX_LAT ?? 70);

let grid = null;

export function loadSeaGrid() {
  if (grid) return grid;

  let buffer;
  try {
    buffer = readFileSync(GRID_PATH);
  } catch {
    throw new Error(
      `No se encontro ${GRID_PATH}. Generalo con:\n` +
        '  node scripts/build-sea-grid.js <ne_50m_land.geojson>',
    );
  }

  const magic = buffer.toString('ascii', 0, 8);
  if (magic !== GRID_MAGIC) throw new Error(`Rejilla con formato desconocido: ${magic}`);

  const width = buffer.readUInt16LE(8);
  const height = buffer.readUInt16LE(10);
  const resolution = buffer.readFloatLE(12);
  const bits = buffer.subarray(16);

  // Costes por fila: la rejilla es regular en grados, no en metros. Un grado de
  // longitud son 111 km en el ecuador y casi nada cerca del polo, asi que el
  // coste de moverse al este depende de la latitud.
  const latOf = (row) => -90 + (row + 0.5) * resolution;
  const eastCost = new Float64Array(height);
  const diagCost = new Float64Array(height);
  const northCost = haversineMeters(0, 0, resolution, 0);
  for (let row = 0; row < height; row += 1) {
    const lat = latOf(row);
    eastCost[row] = haversineMeters(lat, 0, lat, resolution);
    const nextLat = Math.min(89.999, lat + resolution);
    diagCost[row] = haversineMeters(lat, 0, nextLat, resolution);
  }

  grid = {
    width,
    height,
    resolution,
    bits,
    eastCost,
    diagCost,
    northCost,
    latOf,
    lonOf: (col) => -180 + (col + 0.5) * resolution,
    colOf: (lon) => {
      const c = Math.floor((((lon + 180) % 360) + 360) % 360 / resolution);
      return Math.min(width - 1, Math.max(0, c));
    },
    rowOf: (lat) => Math.min(height - 1, Math.max(0, Math.floor((lat + 90) / resolution))),
    isSea(idx) {
      return (bits[idx >> 3] & (1 << (idx & 7))) !== 0;
    },
  };
  return grid;
}

/** ¿Es navegable esta celda, respetando ademas el limite de latitud? */
function navigable(g, row, col) {
  if (Math.abs(g.latOf(row)) > MAX_ROUTING_LATITUDE) return false;
  return g.isSea(row * g.width + col);
}

/**
 * Celda de mar mas cercana a un punto. Los puertos estan en la costa, asi que
 * su centroide cae en tierra a menudo: hay que salir al agua antes de enrutar.
 * Busca en anillos crecientes; si a `maxRings` celdas no hay mar, se rinde.
 */
export function snapToSea(lat, lon, maxRings = 24) {
  const g = loadSeaGrid();
  const row0 = g.rowOf(lat);
  const col0 = g.colOf(lon);
  if (navigable(g, row0, col0)) return { row: row0, col: col0, movedCells: 0 };

  for (let ring = 1; ring <= maxRings; ring += 1) {
    let best = null;
    let bestDist = Infinity;
    for (let dr = -ring; dr <= ring; dr += 1) {
      for (let dc = -ring; dc <= ring; dc += 1) {
        // Solo el borde del anillo: el interior ya se miro antes.
        if (Math.abs(dr) !== ring && Math.abs(dc) !== ring) continue;
        const row = row0 + dr;
        if (row < 0 || row >= g.height) continue;
        const col = (col0 + dc + g.width) % g.width;
        if (!navigable(g, row, col)) continue;
        const d = haversineMeters(lat, lon, g.latOf(row), g.lonOf(col));
        if (d < bestDist) {
          bestDist = d;
          best = { row, col, movedCells: ring };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// Estructuras reutilizadas entre llamadas. Limpiar un millon de casillas en
// cada peticion costaria mas que la propia busqueda, asi que se marcan con un
// numero de pasada en vez de borrarse.
let scratch = null;
let generation = 0;

function getScratch(size) {
  if (!scratch || scratch.g.length !== size) {
    scratch = {
      g: new Float64Array(size),
      f: new Float64Array(size),
      from: new Int32Array(size),
      seen: new Uint32Array(size),
      closed: new Uint8Array(size),
    };
  }
  return scratch;
}

/** Monticulo binario minimo sobre indices de celda, ordenado por f. */
class MinHeap {
  constructor(f) {
    this.items = [];
    this.f = f;
  }
  get size() {
    return this.items.length;
  }
  push(idx) {
    const a = this.items;
    a.push(idx);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[a[p]] <= this.f[a[i]]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && this.f[a[l]] < this.f[a[s]]) s = l;
        if (r < a.length && this.f[a[r]] < this.f[a[s]]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

const NEIGHBOURS = [
  [0, 1], [0, -1], [1, 0], [-1, 0],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Camino navegable entre dos puntos, con A* sobre la rejilla de mar.
 *
 * La heuristica es la distancia de gran circulo hasta el destino: nunca
 * sobreestima lo que queda (ninguna ruta por mar es mas corta que la linea
 * recta sobre la esfera), asi que A* sigue devolviendo el camino optimo de la
 * rejilla.
 *
 * @returns {{points: [number, number][], meters: number, expanded: number}|null}
 */
export function findSeaRoute(fromLat, fromLon, toLat, toLon) {
  const g = loadSeaGrid();
  const start = snapToSea(fromLat, fromLon);
  const goal = snapToSea(toLat, toLon);
  if (!start || !goal) return null;

  const size = g.width * g.height;
  const s = getScratch(size);
  generation += 1;
  const gen = generation;

  const startIdx = start.row * g.width + start.col;
  const goalIdx = goal.row * g.width + goal.col;
  const goalLat = g.latOf(goal.row);
  const goalLon = g.lonOf(goal.col);

  const heuristic = (row, col) => haversineMeters(g.latOf(row), g.lonOf(col), goalLat, goalLon);

  // closed se reutiliza entre llamadas y solo vale para la pasada actual: hay
  // que ponerlo a cero AQUI tambien. Sin esto, una celda que quedo cerrada en
  // una busqueda anterior bloquea la siguiente que empiece ahi.
  s.seen[startIdx] = gen;
  s.closed[startIdx] = 0;
  s.g[startIdx] = 0;
  s.f[startIdx] = heuristic(start.row, start.col);
  s.from[startIdx] = -1;

  const open = new MinHeap(s.f);
  open.push(startIdx);
  let expanded = 0;

  while (open.size) {
    const current = open.pop();
    // Todo lo que entra al monticulo ya tiene seen = gen y closed = 0, asi que
    // aqui basta con mirar closed.
    if (s.closed[current]) continue;
    s.closed[current] = 1;
    expanded += 1;

    if (current === goalIdx) {
      return buildResult(g, s, gen, current, fromLat, fromLon, toLat, toLon, expanded);
    }

    const row = Math.floor(current / g.width);
    const col = current % g.width;

    for (const [dr, dc] of NEIGHBOURS) {
      const nr = row + dr;
      if (nr < 0 || nr >= g.height) continue;
      const nc = (col + dc + g.width) % g.width; // el mundo da la vuelta
      if (!navigable(g, nr, nc)) continue;

      // Nada de cortar esquinas: dos celdas de mar en diagonal pueden tener
      // tierra en las dos celdas ortogonales que comparten, y el barco pasaria
      // justo por la punta del cabo. Se exige que el giro tambien sea agua.
      if (dr !== 0 && dc !== 0) {
        if (!navigable(g, row, nc) || !navigable(g, nr, col)) continue;
      }

      const n = nr * g.width + nc;
      if (s.seen[n] === gen && s.closed[n] === 1) continue;

      const step = dr === 0 ? g.eastCost[row] : dc === 0 ? g.northCost : g.diagCost[Math.min(row, nr)];
      const tentative = s.g[current] + step;

      if (s.seen[n] !== gen) {
        s.seen[n] = gen;
        s.closed[n] = 0;
        s.g[n] = Infinity;
      }
      if (tentative < s.g[n]) {
        s.g[n] = tentative;
        s.f[n] = tentative + heuristic(nr, nc);
        s.from[n] = current;
        open.push(n);
      }
    }
  }
  return null; // sin camino: normalmente un punto encerrado en agua interior
}

function buildResult(g, s, gen, goalIdx, fromLat, fromLon, toLat, toLon, expanded) {
  const cells = [];
  for (let idx = goalIdx; idx !== -1; idx = s.from[idx]) {
    cells.push(idx);
    if (s.from[idx] === -1) break;
  }
  cells.reverse();

  const raw = cells.map((idx) => [
    g.latOf(Math.floor(idx / g.width)),
    g.lonOf(idx % g.width),
  ]);

  // Los extremos reales son los puertos, no el centro de su celda de mar.
  const points = simplify(g, [[fromLat, fromLon], ...raw, [toLat, toLon]]);

  let meters = 0;
  for (let i = 1; i < points.length; i += 1) {
    meters += haversineMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return { points, meters, expanded };
}

/**
 * Tira del hilo: mientras el tramo recto entre dos puntos no pise tierra, los
 * intermedios sobran. Quita el escalonado de la rejilla sin sacar la ruta del
 * agua.
 */
function simplify(g, points) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let anchor = 0;

  while (anchor < points.length - 1) {
    let next = anchor + 1;
    for (let candidate = points.length - 1; candidate > anchor + 1; candidate -= 1) {
      if (segmentIsSea(g, points[anchor], points[candidate])) {
        next = candidate;
        break;
      }
    }
    out.push(points[next]);
    anchor = next;
  }
  return out;
}

/**
 * ¿El segmento recto entre dos puntos se mantiene sobre mar?
 *
 * Recorre TODAS las celdas que el segmento atraviesa, con el algoritmo de
 * Amanatides y Woo. Muestrear a intervalos no vale: por muy fino que se afine,
 * un segmento puede cortar la esquina de una celda de tierra entre dos
 * muestras. Asi se colo un Singapur-Rotterdam que rozaba el cabo Guardafui.
 */
export function segmentIsSea(g, [lat1, lon1], [lat2, lon2]) {
  let dLon = lon2 - lon1;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;

  // A coordenadas continuas de rejilla.
  const x0 = (lon1 + 180) / g.resolution;
  const y0 = (lat1 + 90) / g.resolution;
  const x1 = x0 + dLon / g.resolution;
  const y1 = (lat2 + 90) / g.resolution;

  const dx = x1 - x0;
  const dy = y1 - y0;
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const endX = Math.floor(x1);
  const endY = Math.floor(y1);

  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const tDeltaX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const tDeltaY = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
  let tMaxX = dx !== 0 ? (stepX > 0 ? cx + 1 - x0 : x0 - cx) / Math.abs(dx) : Infinity;
  let tMaxY = dy !== 0 ? (stepY > 0 ? cy + 1 - y0 : y0 - cy) / Math.abs(dy) : Infinity;

  // Tope de seguridad: ni el segmento mas largo posible cruza tantas celdas.
  const maxCells = g.width + g.height + 4;
  for (let i = 0; i < maxCells; i += 1) {
    if (cy < 0 || cy >= g.height) return false;
    if (!navigable(g, cy, ((cx % g.width) + g.width) % g.width)) return false;
    if (cx === endX && cy === endY) return true;

    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      cx += stepX;
    } else {
      tMaxY += tDeltaY;
      cy += stepY;
    }
  }
  return false;
}
