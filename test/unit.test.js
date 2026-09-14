import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineMeters,
  greatCirclePath,
  interpolateGreatCircle,
  downsampleEvenly,
  metersToNauticalMiles,
  pathLengthMeters,
} from '../src/lib/geo.js';
import { classifyShipType, isMerchant } from '../src/lib/shipTypes.js';
import { navStatusLabel } from '../src/lib/navStatus.js';
import { flagFromMmsi } from '../src/lib/mid.js';
import { PortIndex, classifyCall, BERTH_RADIUS_FRACTION } from '../src/core/portIndex.js';
import { medianOf, pickMostTypicalLeg } from '../src/core/routes.js';
import { aggregateByDay } from '../src/jobs/retention.js';
import { partitionNameFor, monthOfPartition, addMonths, monthStart } from '../src/jobs/partitions.js';
import { parseAisTime } from '../src/ingest/aisstream.js';
import { describeCargoOperations } from '../src/core/cargoOperations.js';

// --- 4.1 Filtrado de buques mercantes -------------------------------------

test('solo los codigos AIS 70-89 se aceptan como mercantes', () => {
  assert.equal(classifyShipType(70), 'Cargo');
  assert.equal(classifyShipType(79), 'Cargo');
  assert.equal(classifyShipType(80), 'Tanker');
  assert.equal(classifyShipType(89), 'Tanker');

  // Pasaje, pesca, remolcador, recreo, WIG/aeronave, servicio: fuera.
  for (const code of [0, 30, 31, 36, 37, 40, 50, 52, 60, 69, 90, 99, -1, null, undefined, 'x', 70.5]) {
    assert.equal(classifyShipType(code), null, `codigo ${code} no deberia ser mercante`);
  }
  assert.equal(isMerchant(74), true);
  assert.equal(isMerchant(60), false);
});

test('nav_status desconocido se conserva, no se inventa', () => {
  assert.equal(navStatusLabel(1), 'at anchor');
  assert.equal(navStatusLabel(5), 'moored');
  assert.equal(navStatusLabel(23), 'unknown (23)');
  assert.equal(navStatusLabel('nope'), null);
});

test('la bandera se deriva del MID y devuelve null si no se conoce', () => {
  assert.equal(flagFromMmsi(636012345), 'LR'); // Liberia
  assert.equal(flagFromMmsi(352001234), 'PA'); // Panama
  assert.equal(flagFromMmsi(538001234), 'MH'); // Islas Marshall
  assert.equal(flagFromMmsi(999999999), null); // no es MMSI de buque
  assert.equal(flagFromMmsi(12345), null);
});

// --- Geometria -------------------------------------------------------------

test('haversine reproduce distancias conocidas', () => {
  // Un grado de latitud en el ecuador: ~111,2 km
  assert.ok(Math.abs(haversineMeters(0, 0, 1, 0) - 111_195) < 300);
  assert.equal(haversineMeters(10, 20, 10, 20), 0);

  // Rotterdam -> Hamburgo, ~370 km en linea recta sobre la esfera.
  const d = haversineMeters(51.95, 4.14, 53.54, 9.93);
  assert.ok(d > 400_000 && d < 460_000, `distancia inesperada: ${Math.round(d)} m`);
});

test('el gran circulo empieza y acaba en los extremos y tiene el numero de puntos pedido', () => {
  const path = greatCirclePath(36.13, -5.44, 39.44, -0.31, 20);
  assert.equal(path.length, 22); // origen + 20 intermedios + destino

  assert.ok(Math.abs(path[0][0] - 36.13) < 1e-9);
  assert.ok(Math.abs(path[0][1] - -5.44) < 1e-9);
  assert.ok(Math.abs(path[21][0] - 39.44) < 1e-9);
  assert.ok(Math.abs(path[21][1] - -0.31) < 1e-9);

  // Un gran circulo nunca es mas largo que la suma de sus tramos por mucho.
  const direct = haversineMeters(36.13, -5.44, 39.44, -0.31);
  assert.ok(Math.abs(pathLengthMeters(path) - direct) < direct * 0.001);
});

test('el gran circulo cruza el antimeridiano sin romperse', () => {
  const path = greatCirclePath(35.62, 139.78, 33.73, -118.26, 20);
  for (const [lat, lon] of path) {
    assert.ok(lat >= -90 && lat <= 90, `lat fuera de rango: ${lat}`);
    assert.ok(lon >= -180 && lon <= 180, `lon fuera de rango: ${lon}`);
  }
  // El punto medio cae en el Pacifico norte, no en el Atlantico.
  const [midLat] = interpolateGreatCircle(35.62, 139.78, 33.73, -118.26, 0.5);
  assert.ok(midLat > 40, `el arco deberia subir hacia el norte, midLat=${midLat}`);
});

test('interpolar entre dos puntos identicos no divide por cero', () => {
  assert.deepEqual(interpolateGreatCircle(10, 10, 10, 10, 0.5), [10, 10]);
});

test('downsampleEvenly conserva primero y ultimo y respeta el tope', () => {
  const items = Array.from({ length: 500 }, (_, i) => i);
  const out = downsampleEvenly(items, 60);
  assert.equal(out.length, 60);
  assert.equal(out[0], 0);
  assert.equal(out.at(-1), 499);
  // Estrictamente creciente: no repite puntos.
  for (let i = 1; i < out.length; i += 1) assert.ok(out[i] > out[i - 1]);

  // Por debajo del tope se devuelve todo tal cual.
  assert.deepEqual(downsampleEvenly([1, 2, 3], 60), [1, 2, 3]);
});

test('millas nauticas', () => {
  assert.ok(Math.abs(metersToNauticalMiles(1852) - 1) < 1e-12);
});

// --- 4.2 Clasificacion fondeo / atraque ------------------------------------

test('atracado si esta por debajo del 30% del radio, fondeado si no', () => {
  assert.equal(BERTH_RADIUS_FRACTION, 0.3);
  assert.equal(classifyCall(0, 8000), 'berth');
  assert.equal(classifyCall(2399, 8000), 'berth');
  assert.equal(classifyCall(2400, 8000), 'anchorage'); // justo en el 30%
  assert.equal(classifyCall(7999, 8000), 'anchorage');
});

test('PortIndex encuentra el puerto que contiene el punto y descarta el resto', () => {
  const index = new PortIndex([
    { id: 1, unlocode: 'NLRTM', name: 'Rotterdam', country: 'NL', lat: 51.95, lon: 4.14, approach_radius_m: 15000 },
    { id: 2, unlocode: 'DEHAM', name: 'Hamburg', country: 'DE', lat: 53.54, lon: 9.93, approach_radius_m: 12000 },
  ]);

  const atBerth = index.findEnclosing(51.95, 4.14);
  assert.equal(atBerth.port.id, 1);
  assert.equal(atBerth.callType, 'berth');

  // ~9 km al norte del centro de Rotterdam: dentro del radio, lejos del centro.
  const atAnchor = index.findEnclosing(52.031, 4.14);
  assert.equal(atAnchor.port.id, 1);
  assert.equal(atAnchor.callType, 'anchorage');

  assert.equal(index.findEnclosing(52.6, 7.0), null); // mar abierto entre ambos
  assert.equal(index.isWithinPort(51.95, 4.14, 1), true);
  assert.equal(index.isWithinPort(51.95, 4.14, 2), false);
});

test('con radios solapados gana el centroide mas cercano', () => {
  const index = new PortIndex([
    { id: 1, name: 'A', lat: 0, lon: 0, approach_radius_m: 20000 },
    { id: 2, name: 'B', lat: 0.1, lon: 0, approach_radius_m: 20000 },
  ]);
  assert.equal(index.findEnclosing(0.09, 0).port.id, 2);
  assert.equal(index.findEnclosing(0.01, 0).port.id, 1);
});

test('el prefiltro por latitud no pierde puertos cerca del borde del cubo', () => {
  // Puerto justo por encima de un grado entero, punto justo por debajo.
  const index = new PortIndex([
    { id: 1, name: 'Borde', lat: 52.002, lon: 4.0, approach_radius_m: 15000 },
  ]);
  assert.equal(index.findEnclosing(51.998, 4.0)?.port.id, 1);
});

// --- 4.5 Eleccion del tramo tipico -----------------------------------------

test('medianOf con numero par e impar de elementos', () => {
  assert.equal(medianOf([1, 2, 3]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 2.5);
  assert.equal(medianOf([]), null);
});

test('pickMostTypicalLeg elige el tramo mas cercano a la mediana, no el mas corto', () => {
  const legs = [
    { id: 'a', transit_seconds: 100 },
    { id: 'b', transit_seconds: 500 },
    { id: 'c', transit_seconds: 520 },
    { id: 'd', transit_seconds: 5000 },
  ];
  // mediana = (500+520)/2 = 510 -> 'b' y 'c' empatan a 10; gana el primero.
  assert.equal(pickMostTypicalLeg(legs).id, 'b');
  assert.equal(pickMostTypicalLeg([{ id: 'z', transit_seconds: 7 }]).id, 'z');
});

// --- 7 Particionado y resumen ----------------------------------------------

test('nombres de particion y vuelta atras', () => {
  const m = monthStart(new Date('2026-09-14T22:00:00Z'));
  assert.equal(partitionNameFor(m), 'vessel_positions_2026_09');
  assert.equal(partitionNameFor(addMonths(m, 4)), 'vessel_positions_2027_01');
  assert.deepEqual(monthOfPartition('vessel_positions_2027_01'), new Date(Date.UTC(2027, 0, 1)));
  assert.equal(monthOfPartition('vessel_positions_2027_01_archived'), null);
  assert.equal(monthOfPartition('otra_tabla'), null);
});

test('aggregateByDay no arrastra millas de un dia al siguiente', () => {
  const rows = [
    { recorded_at: new Date('2026-03-01T00:00:00Z'), lat: 0, lon: 0, sog: 10 },
    { recorded_at: new Date('2026-03-01T12:00:00Z'), lat: 0, lon: 1, sog: 12 },
    // Salto grande de un dia a otro: no debe contarse en ninguno de los dos.
    { recorded_at: new Date('2026-03-02T00:00:00Z'), lat: 0, lon: 10, sog: null },
    { recorded_at: new Date('2026-03-02T12:00:00Z'), lat: 0, lon: 11, sog: 8 },
  ];
  const days = aggregateByDay(rows);
  assert.equal(days.length, 2);

  const oneDegreeNm = metersToNauticalMiles(haversineMeters(0, 0, 0, 1));
  assert.ok(Math.abs(days[0].distanceNm - oneDegreeNm) < 0.01);
  assert.ok(Math.abs(days[1].distanceNm - oneDegreeNm) < 0.01);
  assert.equal(days[0].count, 2);
  assert.equal(days[0].avgSog, 11);
  assert.equal(days[1].avgSog, 8); // la posicion sin sog no cuenta en la media
});

// --- Ingesta ---------------------------------------------------------------

test('parseAisTime entiende el formato de aisstream', () => {
  const d = parseAisTime('2026-05-01 12:34:56.789012345 +0000 UTC');
  assert.equal(d.toISOString(), '2026-05-01T12:34:56.789Z');
  assert.equal(parseAisTime('2026-05-01T12:34:56Z').toISOString(), '2026-05-01T12:34:56.000Z');
  // Sin hora utilizable se cae a "ahora", nunca a una hora pasada inventada.
  assert.ok(Math.abs(parseAisTime('basura').getTime() - Date.now()) < 5000);
});

// --- 4.3 Lo que el AIS no da -----------------------------------------------

test('la operacion de carga se declara no disponible, nunca estimada', () => {
  const berth = describeCargoOperations({
    call_type: 'berth',
    arrived_at: new Date('2026-01-01T00:00:00Z'),
    departed_at: null,
    dwell_seconds: 3600,
  });
  assert.equal(berth.available, false);
  assert.equal(berth.likely_working_window.is_open, true);
  assert.equal(berth.likely_working_window.basis, 'berth_port_call');
  // No hay ni cantidad de carga ni marcas de inicio/fin de descarga.
  assert.equal(berth.cargo_quantity, undefined);
  assert.equal(berth.discharge_started_at, undefined);

  const anchorage = describeCargoOperations({ call_type: 'anchorage', arrived_at: new Date(), departed_at: null });
  assert.equal(anchorage.available, false);
  assert.equal(anchorage.likely_working_window, null);

  assert.equal(describeCargoOperations(null).likely_working_window, null);
});
