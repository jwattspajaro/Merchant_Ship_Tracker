import test from 'node:test';
import assert from 'node:assert/strict';

import { findSeaRoute, snapToSea, loadSeaGrid, segmentIsSea } from '../src/core/seaRoute.js';
import { metersToNauticalMiles } from '../src/lib/geo.js';

const grid = loadSeaGrid();
const nm = (m) => metersToNauticalMiles(m);

const isSeaAt = (lat, lon) => grid.isSea(grid.rowOf(lat) * grid.width + grid.colOf(lon));

/**
 * Comprobacion independiente del algoritmo del enrutador: muestrea el trazado
 * muy fino y mira si algun punto cae en tierra. Se saltan el primer y ultimo
 * segmento, cuyos extremos son los centroides de los puertos, que estan en la
 * costa por definicion.
 */
function crossesLand(points) {
  for (let i = 2; i < points.length - 1; i += 1) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    let dLon = lon2 - lon1;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;

    const steps = Math.ceil(Math.max(Math.abs(dLon), Math.abs(lat2 - lat1)) / 0.02) || 1;
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const lat = lat1 + (lat2 - lat1) * t;
      let lon = lon1 + dLon * t;
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      if (!isSeaAt(lat, lon)) return [Number(lat.toFixed(2)), Number(lon.toFixed(2))];
    }
  }
  return null;
}

const PORTS = {
  rotterdam: [51.95, 4.14],
  shanghai: [31.23, 121.49],
  singapore: [1.26, 103.83],
  losAngeles: [33.73, -118.26],
  newYork: [40.67, -74.05],
  jebelAli: [25.01, 55.06],
  cartagena: [10.4, -75.52],
  buenaventura: [3.893, -77.074],
  santos: [-23.96, -46.3],
  durban: [-29.87, 31.02],
  yokohama: [35.45, 139.66],
  valencia: [39.44, -0.31],
};

test('la rejilla de mar esta generada y tiene el tamano esperado', () => {
  assert.equal(grid.width, 1440);
  assert.equal(grid.height, 720);
  assert.ok(Math.abs(grid.resolution - 0.25) < 1e-6);
  // Mar abierto y tierra firme, para saber que la mascara no esta invertida.
  assert.equal(isSeaAt(40, -30), true, 'Atlantico Norte deberia ser mar');
  assert.equal(isSeaAt(47, 2), false, 'el centro de Francia no deberia ser mar');
  assert.equal(isSeaAt(-15, -60), false, 'el centro de Brasil no deberia ser mar');
});

test('ninguna ruta calculada cruza tierra', () => {
  const pares = [
    ['Cartagena', 'Shanghai', PORTS.cartagena, PORTS.shanghai],
    ['Cartagena', 'Rotterdam', PORTS.cartagena, PORTS.rotterdam],
    ['Rotterdam', 'Shanghai', PORTS.rotterdam, PORTS.shanghai],
    ['Singapur', 'Rotterdam', PORTS.singapore, PORTS.rotterdam],
    ['Nueva York', 'Los Angeles', PORTS.newYork, PORTS.losAngeles],
    ['Jebel Ali', 'Rotterdam', PORTS.jebelAli, PORTS.rotterdam],
    ['Santos', 'Durban', PORTS.santos, PORTS.durban],
    ['Buenaventura', 'Yokohama', PORTS.buenaventura, PORTS.yokohama],
    ['Singapur', 'Los Angeles', PORTS.singapore, PORTS.losAngeles],
    ['Cartagena', 'Valencia', PORTS.cartagena, PORTS.valencia],
  ];

  for (const [a, b, from, to] of pares) {
    const route = findSeaRoute(from[0], from[1], to[0], to[1]);
    assert.ok(route, `${a} -> ${b}: deberia haber ruta`);
    const land = crossesLand(route.points);
    assert.equal(land, null, `${a} -> ${b} cruza tierra en ${land}`);
  }
});

test('A* no corta esquinas en diagonal', () => {
  // Cualquier par consecutivo del trazado tiene que ser recorrible sin pisar
  // tierra. Antes fallaba: dos celdas de mar en diagonal con tierra en las dos
  // ortogonales dejaban pasar el barco por la punta del cabo.
  for (const [from, to] of [
    [PORTS.rotterdam, PORTS.shanghai],
    [PORTS.singapore, PORTS.rotterdam],
    [PORTS.jebelAli, PORTS.rotterdam],
  ]) {
    const { points } = findSeaRoute(from[0], from[1], to[0], to[1]);
    for (let i = 2; i < points.length - 1; i += 1) {
      assert.ok(
        segmentIsSea(grid, points[i - 1], points[i]),
        `el segmento ${i - 1}->${i} (${points[i - 1]} -> ${points[i]}) no es navegable`,
      );
    }
  }
});

test('las rutas usan los canales, no rodean los continentes', () => {
  // Nueva York -> Los Angeles: por Panama son ~4.900 millas; rodeando
  // Sudamerica pasan de 13.000. La linea recta son 2.132, imposible por mar.
  const panama = nm(findSeaRoute(...PORTS.newYork, ...PORTS.losAngeles).meters);
  assert.ok(panama > 4300 && panama < 5600, `via Panama deberian ser ~4.900 NM, dio ${panama.toFixed(0)}`);

  // Jebel Ali -> Rotterdam: por Suez ~6.400; por el Cabo de Buena Esperanza ~11.000.
  const suez = nm(findSeaRoute(...PORTS.jebelAli, ...PORTS.rotterdam).meters);
  assert.ok(suez > 5800 && suez < 7200, `via Suez deberian ser ~6.400 NM, dio ${suez.toFixed(0)}`);

  // Gibraltar: Cartagena (Colombia) -> Valencia entra al Mediterraneo.
  const gibraltar = nm(findSeaRoute(...PORTS.cartagena, ...PORTS.valencia).meters);
  assert.ok(gibraltar > 3900 && gibraltar < 5000, `deberian ser ~4.400 NM, dio ${gibraltar.toFixed(0)}`);
});

test('las distancias se acercan a las tablas nauticas', () => {
  const referencias = [
    ['Rotterdam - Singapur', PORTS.rotterdam, PORTS.singapore, 8300],
    ['Rotterdam - Shanghai', PORTS.rotterdam, PORTS.shanghai, 10500],
    ['Rotterdam - Nueva York', PORTS.rotterdam, PORTS.newYork, 3300],
    ['Shanghai - Los Angeles', PORTS.shanghai, PORTS.losAngeles, 5700],
    ['Singapur - Los Angeles', PORTS.singapore, PORTS.losAngeles, 7600],
  ];
  for (const [nombre, from, to, esperado] of referencias) {
    const got = nm(findSeaRoute(from[0], from[1], to[0], to[1]).meters);
    const desvio = Math.abs(got - esperado) / esperado;
    assert.ok(desvio < 0.1, `${nombre}: ${got.toFixed(0)} NM frente a ~${esperado} (desvio ${(desvio * 100).toFixed(0)}%)`);
  }
});

test('por defecto no se enruta por el Artico', () => {
  // Con el Artico abierto, Rotterdam - Singapur baja de 8.300 a ~9.100 por la
  // Ruta del Mar del Norte... que es MAS corta que por Suez en linea recta
  // pero no es por donde va el trafico mercante. El tope de latitud lo evita.
  const { points } = findSeaRoute(...PORTS.rotterdam, ...PORTS.singapore);
  const maxLat = Math.max(...points.map((p) => p[0]));
  assert.ok(maxLat <= 70, `la ruta subio a ${maxLat.toFixed(1)} grados de latitud`);
});

test('un puerto en tierra se engancha a la celda de mar mas cercana', () => {
  // El centroide de Rotterdam cae en tierra en una rejilla de 28 km.
  const snapped = snapToSea(51.95, 4.14);
  assert.ok(snapped, 'deberia encontrar mar cerca');
  assert.ok(snapped.movedCells <= 3, `se alejo ${snapped.movedCells} celdas`);
  assert.equal(grid.isSea(snapped.row * grid.width + snapped.col), true);

  // Un punto en mitad de un continente no tiene mar cerca.
  assert.equal(snapToSea(-15, -60, 4), null, 'el centro de Brasil no deberia engancharse');
});

test('la ruta empieza y acaba exactamente en los puertos pedidos', () => {
  const { points } = findSeaRoute(...PORTS.cartagena, ...PORTS.rotterdam);
  assert.deepEqual(points[0], PORTS.cartagena);
  assert.deepEqual(points.at(-1), PORTS.rotterdam);
  assert.ok(points.length >= 3);
});
