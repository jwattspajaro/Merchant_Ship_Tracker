import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCoverageGap,
  reconstructGap,
  findGaps,
  MIN_PLAUSIBLE_SPEED_KN,
  MAX_PLAUSIBLE_SPEED_KN,
} from '../src/core/gaps.js';
import { PortIndex } from '../src/core/portIndex.js';
import { loadSeaGrid } from '../src/core/seaRoute.js';

const grid = loadSeaGrid();
const at = (iso) => new Date(iso);
const pos = (lat, lon, iso) => ({ lat, lon, recordedAt: at(iso) });

// Dos puertos reales del seed, para el caso "el hueco es dentro del puerto".
const portIndex = new PortIndex([
  { id: 1, unlocode: 'NLRTM', name: 'Rotterdam', lat: 51.95, lon: 4.14, approach_radius_m: 15000 },
  { id: 2, unlocode: 'CNSHA', name: 'Shanghai', lat: 31.23, lon: 121.49, approach_radius_m: 15000 },
]);

test('un hueco corto no cuenta como hueco de cobertura', () => {
  const a = pos(20, -40, '2026-09-01T00:00:00Z');
  const b = pos(20.5, -40.5, '2026-09-01T03:00:00Z'); // 3 h
  assert.equal(isCoverageGap(a, b, portIndex, 6), false);
});

test('un buque amarrado que deja de emitir NO es un hueco de cobertura', () => {
  // Las dos posiciones caen dentro del radio del mismo puerto: el buque no se
  // ha movido, y reconstruirle una ruta seria inventarse un viaje.
  const a = pos(51.95, 4.14, '2026-09-01T00:00:00Z');
  const b = pos(51.96, 4.15, '2026-09-04T00:00:00Z'); // 3 dias parado
  assert.equal(isCoverageGap(a, b, portIndex, 6), false);
});

test('desaparecer en mar abierto si es un hueco de cobertura', () => {
  const a = pos(20, -40, '2026-09-01T00:00:00Z');
  const b = pos(25, -55, '2026-09-04T00:00:00Z');
  assert.equal(isCoverageGap(a, b, portIndex, 6), true);
});

test('el hueco se reconstruye con velocidad media y duracion en dias', () => {
  // Mitad del Atlantico a las Azores: unas 800 NM, cuatro dias.
  const a = pos(35, -40, '2026-09-01T00:00:00Z');
  const b = pos(38.5, -28.5, '2026-09-05T00:00:00Z');
  const gap = reconstructGap(a, b);

  assert.equal(gap.gapDays, 4);
  assert.equal(gap.gapSeconds, 4 * 86_400);
  assert.ok(gap.seaRouteNm > 0);
  assert.ok(gap.impliedSpeedKn > 0);
  assert.equal(gap.plausible, true);
  assert.equal(gap.reason, null);
  assert.ok(Array.isArray(gap.pathPoints) && gap.pathPoints.length >= 2);

  // La velocidad implicita sale de la ruta por mar, no de la linea recta: la
  // recta es mas corta y daria una velocidad menor que la real.
  assert.ok(gap.seaRouteNm >= gap.straightNm);
  const desdeLaRecta = gap.straightNm / (gap.gapSeconds / 3600);
  assert.ok(gap.impliedSpeedKn >= desdeLaRecta);
});

test('el trayecto reconstruido no cruza tierra', () => {
  const a = pos(36.0, -9.5, '2026-09-01T00:00:00Z');   // Atlantico, frente a Lisboa
  const b = pos(37.9, 23.6, '2026-09-12T00:00:00Z');   // Egeo, frente a Piraeus
  const gap = reconstructGap(a, b);
  assert.equal(gap.plausible, true);

  // Se saltan el primer y ultimo tramo: sus extremos son los puntos pedidos,
  // que en este caso estan a la vista de la costa y caen en celda de tierra.
  const isSea = (lat, lon) => grid.isSea(grid.rowOf(lat) * grid.width + grid.colOf(lon));
  for (let i = 2; i < gap.pathPoints.length - 1; i += 1) {
    const [lat1, lon1] = gap.pathPoints[i - 1];
    const [lat2, lon2] = gap.pathPoints[i];
    const steps = Math.ceil(Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1)) / 0.05) || 1;
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const lat = lat1 + (lat2 - lat1) * t;
      const lon = lon1 + (lon2 - lon1) * t;
      assert.ok(isSea(lat, lon), `el tramo estimado pisa tierra en ${lat.toFixed(2)},${lon.toFixed(2)}`);
    }
  }
});

test('una velocidad implicita imposible se marca y no se dibuja', () => {
  // Rotterdam a Shanghai en 12 horas: ninguna nave mercante hace eso.
  const a = pos(52.1, 4.0, '2026-09-01T00:00:00Z');
  const b = pos(31.0, 122.5, '2026-09-01T12:00:00Z');
  const gap = reconstructGap(a, b);

  assert.equal(gap.plausible, false);
  assert.equal(gap.reason, 'implied_speed_too_high');
  assert.ok(gap.impliedSpeedKn > MAX_PLAUSIBLE_SPEED_KN);
  // Sin trazado: no se puede dibujar como recorrido algo que no pudo ocurrir.
  assert.equal(gap.pathPoints, null);
});

test('una velocidad implicita absurdamente baja tambien se marca', () => {
  // Un mes para cruzar de Canarias a Madeira: el dato no cuadra.
  const a = pos(28.5, -16.0, '2026-08-01T00:00:00Z');
  const b = pos(32.6, -16.9, '2026-09-01T00:00:00Z');
  const gap = reconstructGap(a, b);
  assert.equal(gap.plausible, false);
  assert.equal(gap.reason, 'implied_speed_too_low');
  assert.ok(gap.impliedSpeedKn < MIN_PLAUSIBLE_SPEED_KN);
  assert.equal(gap.pathPoints, null);
});

test('findGaps recorre la serie y solo devuelve los huecos reales', () => {
  const positions = [
    pos(35.0, -40.0, '2026-09-01T00:00:00Z'),
    pos(35.2, -40.6, '2026-09-01T02:00:00Z'), // 2 h: no es hueco
    pos(38.5, -28.5, '2026-09-05T00:00:00Z'), // 4 dias: si lo es
    pos(38.6, -28.4, '2026-09-05T03:00:00Z'), // 3 h: no
  ];
  const gaps = findGaps(positions, portIndex, 6);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].gapDays, 3.92); // 3 dias y 22 horas
  assert.deepEqual(gaps[0].from.at, at('2026-09-01T02:00:00Z'));
  assert.deepEqual(gaps[0].to.at, at('2026-09-05T00:00:00Z'));
  assert.equal(gaps[0].plausible, true);
});
