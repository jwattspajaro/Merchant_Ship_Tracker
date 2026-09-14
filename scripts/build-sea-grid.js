/**
 * Construye la rejilla de navegacion marítima que usa src/core/seaRoute.js.
 *
 *   node scripts/build-sea-grid.js <ruta a ne_50m_land.geojson>
 *
 * Los poligonos de tierra salen de Natural Earth (dominio publico):
 *   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
 *
 * El GeoJSON no se guarda en el repositorio (1,6 MB y solo hace falta aqui);
 * lo que se guarda es el resultado: data/sea-grid.bin, una mascara de bits de
 * ~130 KB donde 1 = mar navegable.
 *
 * Tres pasos, en este orden:
 *   1. Rasterizar la tierra sobre una rejilla regular.
 *   2. Abrir a mano los pasos mas estrechos que una celda. A 0,25 grados una
 *      celda mide ~28 km en el ecuador, asi que Gibraltar (14 km), el Bosforo
 *      (700 m) o los canales de Panama y Suez desaparecerian y dejarian mares
 *      enteros incomunicados.
 *   3. Quedarse solo con el oceano conectado. Asi el Caspio, los Grandes Lagos
 *      y demas aguas interiores no aparecen como mar navegable, y cualquier par
 *      de celdas de mar tiene garantizado un camino entre ellas.
 *
 * El paso 2 no se da por bueno: al final se comprueba que los mares que deben
 * estar conectados lo estan, y el script falla si alguno no lo esta.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RESOLUTION_DEG = 0.25;
export const GRID_WIDTH = Math.round(360 / RESOLUTION_DEG); // 1440
export const GRID_HEIGHT = Math.round(180 / RESOLUTION_DEG); // 720
export const GRID_MAGIC = 'MSTSEA01';

/**
 * Pasos que hay que abrir a mano porque son mas estrechos que una celda.
 * Cada uno es una polilinea [lon, lat] que se fuerza a mar, con el ancho en
 * celdas necesario para que quede transitable.
 */
const PASSAGES = [
  { name: 'Canal de Panama',      width: 1, line: [[-79.92, 9.37], [-79.75, 9.15], [-79.57, 8.95]] },
  // El canal en si, y ademas todo el golfo de Suez: entre 28,6 y 27,8 grados el
  // golfo mide ~30 km y a esta resolucion desaparece, dejando el Mar Rojo
  // incomunicado del Mediterraneo aunque el canal estuviera abierto.
  { name: 'Canal y golfo de Suez', width: 1,
    line: [[32.31, 31.25], [32.35, 30.60], [32.56, 29.93], [32.55, 29.40], [32.90, 28.90],
           [33.20, 28.30], [33.50, 27.80], [33.90, 27.30], [34.30, 26.90], [34.80, 26.30]] },
  { name: 'Estrecho de Gibraltar',width: 1, line: [[-6.00, 35.95], [-5.60, 35.95], [-5.30, 36.00], [-5.00, 36.05]] },
  { name: 'Bosforo y Dardanelos', width: 1, line: [[26.20, 40.05], [26.40, 40.25], [27.00, 40.40], [28.00, 40.55], [28.95, 40.75], [29.10, 41.20]] },
  { name: 'Estrechos daneses',    width: 1, line: [[10.60, 54.70], [11.00, 55.30], [11.20, 55.80], [12.00, 56.10], [12.70, 55.90], [12.90, 55.60]] },
  { name: 'Bab el-Mandeb',        width: 1, line: [[43.10, 12.90], [43.40, 12.60], [43.70, 12.40]] },
  { name: 'Estrecho de Ormuz',    width: 1, line: [[56.00, 26.70], [56.40, 26.55], [56.80, 26.40]] },
  { name: 'Estrecho de Malaca',   width: 1, line: [[98.50, 6.00], [99.50, 4.50], [101.00, 2.80], [102.50, 1.60], [103.50, 1.20], [104.10, 1.15]] },
  { name: 'Canal de la Mancha',   width: 1, line: [[1.00, 50.90], [1.50, 51.00], [2.00, 51.20]] },
  { name: 'Estrecho de Magallanes', width: 1, line: [[-74.00, -53.20], [-72.00, -53.60], [-70.50, -53.20], [-69.00, -52.60], [-68.30, -52.50]] },
  { name: 'Mar de Marmara a Egeo', width: 1, line: [[23.50, 40.00], [25.00, 40.00], [26.00, 40.00]] },
  { name: 'Estrecho de Sunda',    width: 1, line: [[105.20, -5.60], [105.60, -5.90], [106.00, -6.00]] },
  { name: 'Kattegat a Skagerrak', width: 1, line: [[10.50, 57.40], [10.80, 57.60], [11.20, 57.70]] },
];

/**
 * Pasos que deben quedar TRANSITABLES, no solo conectados.
 *
 * Comprobar solo "¿este mar toca el oceano?" no basta y es como se colo un
 * fallo: con el golfo de Suez cerrado, el Mar Rojo seguia conectado por Bab
 * el-Mandeb y el Mediterraneo por Gibraltar, asi que ambos daban OK mientras
 * un Dubai-Rotterdam se iba por el Cabo de Buena Esperanza. Cada entrada mide
 * la distancia real por la rejilla entre los dos lados del paso.
 */
const PASSAGE_CHECKS = [
  { name: 'Canal de Suez',       a: [32.31, 31.25], b: [34.80, 26.30], maxCells: 45 },
  { name: 'Estrecho de Gibraltar', a: [-7.00, 35.90], b: [-3.00, 36.10], maxCells: 30 },
  { name: 'Canal de Panama',     a: [-79.90, 9.60], b: [-79.50, 8.70], maxCells: 15 },
  { name: 'Bab el-Mandeb',       a: [42.50, 14.00], b: [45.00, 12.50], maxCells: 25 },
  { name: 'Estrecho de Ormuz',   a: [54.00, 26.00], b: [58.00, 24.50], maxCells: 30 },
  { name: 'Bosforo',             a: [28.00, 40.70], b: [29.20, 41.50], maxCells: 20 },
  { name: 'Estrechos daneses',   a: [11.00, 57.20], b: [13.50, 55.20], maxCells: 30 },
  { name: 'Estrecho de Malaca',  a: [97.00, 6.50], b: [104.20, 1.20], maxCells: 70 },
  { name: 'Paso del Drake',      a: [-67.00, -52.50], b: [-75.00, -53.00], maxCells: 60 },
];

/** Mares que DEBEN quedar conectados al oceano. Se comprueba al final. */
const CONNECTIVITY_CHECKS = [
  { name: 'Atlantico Norte',   lon: -30.0, lat: 40.0 },
  { name: 'Pacifico Norte',    lon: -150.0, lat: 30.0 },
  { name: 'Pacifico Oeste',    lon: 140.0, lat: 20.0 },
  { name: 'Indico',            lon: 75.0, lat: -10.0 },
  { name: 'Mediterraneo',      lon: 5.0, lat: 38.0 },
  { name: 'Mar Rojo',          lon: 38.0, lat: 20.0 },
  { name: 'Mar Negro',         lon: 34.0, lat: 43.5 },
  { name: 'Mar Baltico',       lon: 19.0, lat: 57.0 },
  { name: 'Golfo Persico',     lon: 51.0, lat: 27.0 },
  { name: 'Mar del Norte',     lon: 3.0, lat: 56.0 },
  { name: 'Caribe',            lon: -75.0, lat: 15.0 },
  { name: 'Atlantico Sur',     lon: -25.0, lat: -30.0 },
  { name: 'Mar de China Meridional', lon: 114.0, lat: 15.0 },
  { name: 'Oceano Austral',    lon: 0.0, lat: -55.0 },
];

export const colOfLon = (lon) => Math.min(GRID_WIDTH - 1, Math.max(0, Math.floor((lon + 180) / RESOLUTION_DEG)));
export const rowOfLat = (lat) => Math.min(GRID_HEIGHT - 1, Math.max(0, Math.floor((lat + 90) / RESOLUTION_DEG)));
export const lonOfCol = (col) => -180 + (col + 0.5) * RESOLUTION_DEG;
export const latOfRow = (row) => -90 + (row + 0.5) * RESOLUTION_DEG;

/**
 * Rasteriza los anillos de tierra por lineas de barrido: para cada fila de la
 * rejilla se cortan todos los segmentos con esa latitud y se rellena entre
 * cruces alternos (regla par-impar, que respeta los agujeros).
 */
function rasterizeLand(geojson) {
  const land = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  const rings = [];
  for (const feature of geojson.features) {
    const geom = feature.geometry;
    if (!geom) continue;
    const polygons = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const polygon of polygons) for (const ring of polygon) rings.push(ring);
  }

  for (let row = 0; row < GRID_HEIGHT; row += 1) {
    const lat = latOfRow(row);
    const crossings = [];

    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        // El segmento cruza esta latitud (mitad abierta, para no contar dos
        // veces un vertice que cae justo en la linea).
        if ((y1 <= lat && y2 > lat) || (y2 <= lat && y1 > lat)) {
          crossings.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }

    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);

    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = colOfLon(crossings[k]);
      const to = colOfLon(crossings[k + 1]);
      for (let col = from; col <= to; col += 1) land[row * GRID_WIDTH + col] = 1;
    }
  }
  return land;
}

/** Fuerza a mar las celdas de una polilinea, con un margen de `width` celdas. */
function carvePassage(land, line, width) {
  let opened = 0;
  const open = (col, row) => {
    for (let dr = -width; dr <= width; dr += 1) {
      for (let dc = -width; dc <= width; dc += 1) {
        const r = row + dr;
        if (r < 0 || r >= GRID_HEIGHT) continue;
        const c = (col + dc + GRID_WIDTH) % GRID_WIDTH;
        if (land[r * GRID_WIDTH + c]) opened += 1;
        land[r * GRID_WIDTH + c] = 0;
      }
    }
  };

  for (let i = 0; i < line.length - 1; i += 1) {
    const [lon1, lat1] = line[i];
    const [lon2, lat2] = line[i + 1];
    // Suficientes pasos para no dejar huecos entre celdas consecutivas.
    const steps = Math.ceil(
      Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1)) / (RESOLUTION_DEG / 2),
    ) || 1;
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      open(colOfLon(lon1 + (lon2 - lon1) * t), rowOfLat(lat1 + (lat2 - lat1) * t));
    }
  }
  return opened;
}

/**
 * Relleno por inundacion desde un punto de oceano abierto. Devuelve la mascara
 * del componente conectado: eso es el mar navegable, y nada mas.
 */
function floodFillOcean(land, startLon, startLat) {
  const sea = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  const start = rowOfLat(startLat) * GRID_WIDTH + colOfLon(startLon);
  if (land[start]) throw new Error('El punto de partida del relleno cayo en tierra');

  // Pila explicita: una recursion de un millon de celdas revienta.
  const stack = [start];
  sea[start] = 1;
  let count = 1;

  while (stack.length) {
    const idx = stack.pop();
    const row = Math.floor(idx / GRID_WIDTH);
    const col = idx % GRID_WIDTH;

    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const r = row + dr;
      if (r < 0 || r >= GRID_HEIGHT) continue;
      const c = (col + dc + GRID_WIDTH) % GRID_WIDTH; // el mundo da la vuelta
      const n = r * GRID_WIDTH + c;
      if (sea[n] || land[n]) continue;
      sea[n] = 1;
      count += 1;
      stack.push(n);
    }
  }
  return { sea, count };
}

/**
 * Distancia en celdas entre dos puntos, por BFS sobre el mar. Devuelve
 * Infinity si no hay camino. Sirve para distinguir "conectado" de "conectado
 * dando la vuelta al mundo".
 */
function cellDistance(sea, [lonA, latA], [lonB, latB], limit) {
  const start = rowOfLat(latA) * GRID_WIDTH + colOfLon(lonA);
  const goal = rowOfLat(latB) * GRID_WIDTH + colOfLon(lonB);
  if (!sea[start] || !sea[goal]) return Infinity;

  const dist = new Int32Array(sea.length).fill(-1);
  dist[start] = 0;
  let frontier = [start];

  while (frontier.length) {
    const next = [];
    for (const idx of frontier) {
      if (idx === goal) return dist[idx];
      if (dist[idx] >= limit) continue;
      const row = Math.floor(idx / GRID_WIDTH);
      const col = idx % GRID_WIDTH;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const r = row + dr;
        if (r < 0 || r >= GRID_HEIGHT) continue;
        const c = (col + dc + GRID_WIDTH) % GRID_WIDTH;
        const n = r * GRID_WIDTH + c;
        if (!sea[n] || dist[n] !== -1) continue;
        dist[n] = dist[idx] + 1;
        next.push(n);
      }
    }
    frontier = next;
  }
  return Infinity;
}

function packBits(sea) {
  const packed = new Uint8Array(Math.ceil(sea.length / 8));
  for (let i = 0; i < sea.length; i += 1) {
    if (sea[i]) packed[i >> 3] |= 1 << (i & 7);
  }
  return packed;
}

function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('Uso: node scripts/build-sea-grid.js <ne_50m_land.geojson>');
    console.error('Descargalo de https://github.com/nvkelso/natural-earth-vector (dominio publico)');
    process.exit(1);
  }

  console.log(`[grid] leyendo ${source}`);
  const geojson = JSON.parse(readFileSync(source, 'utf8'));

  console.log(`[grid] rasterizando a ${RESOLUTION_DEG} grados (${GRID_WIDTH}x${GRID_HEIGHT})`);
  const land = rasterizeLand(geojson);
  const landCells = land.reduce((a, b) => a + b, 0);
  console.log(`[grid] tierra: ${landCells} celdas (${((landCells / land.length) * 100).toFixed(1)}%)`);

  for (const p of PASSAGES) {
    const opened = carvePassage(land, p.line, p.width);
    console.log(`[grid] abierto ${p.name}: ${opened} celdas de tierra liberadas`);
  }

  // Punto de partida: Atlantico Norte abierto, lejos de cualquier costa.
  const { sea, count } = floodFillOcean(land, -30, 40);
  console.log(`[grid] oceano conectado: ${count} celdas (${((count / sea.length) * 100).toFixed(1)}%)`);

  let failures = 0;
  for (const check of CONNECTIVITY_CHECKS) {
    const idx = rowOfLat(check.lat) * GRID_WIDTH + colOfLon(check.lon);
    const ok = sea[idx] === 1;
    console.log(`[grid] ${ok ? 'OK  ' : 'FALLA'} ${check.name}`);
    if (!ok) failures += 1;
  }
  for (const p of PASSAGE_CHECKS) {
    const cells = cellDistance(sea, p.a, p.b, p.maxCells);
    const ok = cells <= p.maxCells;
    console.log(
      `[grid] ${ok ? 'OK  ' : 'FALLA'} paso ${p.name}: ` +
        `${cells === Infinity ? 'sin camino' : cells + ' celdas'} (tope ${p.maxCells})`,
    );
    if (!ok) failures += 1;
  }

  if (failures) {
    console.error(`[grid] ${failures} comprobaciones fallaron. Revisa PASSAGES.`);
    process.exit(1);
  }

  const packed = packBits(sea);
  const header = Buffer.alloc(16);
  header.write(GRID_MAGIC, 0, 'ascii');
  header.writeUInt16LE(GRID_WIDTH, 8);
  header.writeUInt16LE(GRID_HEIGHT, 10);
  header.writeFloatLE(RESOLUTION_DEG, 12);

  mkdirSync(join(root, 'data'), { recursive: true });
  const out = join(root, 'data', 'sea-grid.bin');
  writeFileSync(out, Buffer.concat([header, Buffer.from(packed)]));
  console.log(`[grid] escrito ${out} (${(packed.length / 1024).toFixed(0)} KB)`);
}

main();
