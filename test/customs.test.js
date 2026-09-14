import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAlias,
  normalizeTransportMode,
  normalizeHsCode,
  parseNumber,
  parseDate,
  resolvePort,
} from '../src/core/customs.js';
import { pearson, spearman, MIN_RELIABLE_PERIODS } from '../src/core/tradeCorrelation.js';
import { parseDelimited } from '../scripts/import-customs.js';

test('los alias se normalizan sin tildes ni mayusculas', () => {
  assert.equal(normalizeAlias(' Cartagena '), 'CARTAGENA');
  assert.equal(normalizeAlias('Covenas'), 'COVENAS');
  assert.equal(normalizeAlias('Ciénaga'), 'CIENAGA');
  assert.equal(normalizeAlias(''), null);
  assert.equal(normalizeAlias(null), null);
});

test('el modo de transporte admite codigo, letra y palabra', () => {
  for (const v of ['1', 'M', 'MARITIMO', 'Marítimo', 'sea']) {
    assert.equal(normalizeTransportMode(v), 'maritimo', `fallo con ${v}`);
  }
  assert.equal(normalizeTransportMode('AEREO'), 'aereo');
  assert.equal(normalizeTransportMode('TERRESTRE'), 'terrestre');
  // Lo que no se reconoce queda en null, no se adivina.
  assert.equal(normalizeTransportMode('XYZ'), null);
  assert.equal(normalizeTransportMode(''), null);
});

test('la subpartida se queda en digitos y se puede recortar', () => {
  assert.equal(normalizeHsCode('3920.10.00.00'), '3920100000');
  assert.equal(normalizeHsCode('3920.10.00.00', 6), '392010');
  assert.equal(normalizeHsCode('392010'), '392010');
  assert.equal(normalizeHsCode('sin digitos'), null);
});

test('los numeros toleran separador de miles y coma decimal', () => {
  assert.equal(parseNumber('1.234,56'), 1234.56);   // formato europeo
  assert.equal(parseNumber('1,234.56'), 1234.56);   // formato anglosajon
  assert.equal(parseNumber('252500'), 252500);
  assert.equal(parseNumber(819), 819);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('no es un numero'), null);
});

test('las fechas admiten ISO, dd/mm/aaaa y aaaammdd', () => {
  assert.equal(parseDate('2019-03-15').toISOString().slice(0, 10), '2019-03-15');
  assert.equal(parseDate('15/03/2019').toISOString().slice(0, 10), '2019-03-15');
  assert.equal(parseDate('20190315').toISOString().slice(0, 10), '2019-03-15');
  assert.equal(parseDate(''), null);
});

test('resolvePort prueba varios candidatos y devuelve null si no encaja', () => {
  const aliases = new Map([['CARTAGENA', 95], ['BUENAVENTURA', 96]]);
  assert.equal(resolvePort(aliases, 'Cartagena'), 95);
  // Si el primer candidato no resuelve, prueba el siguiente.
  assert.equal(resolvePort(aliases, 'PUERTO RARO', 'Buenaventura'), 96);
  // Y si ninguno resuelve, null: nunca se adivina un puerto.
  assert.equal(resolvePort(aliases, 'PUERTO RARO', 'OTRO RARO'), null);
});

test('el lector de delimitados respeta comillas y campos con el separador dentro', () => {
  const texto = 'A;B;C\n1;"texto; con separador";3\n4;"comilla ""doble""";6\n';
  const filas = parseDelimited(texto, ';');
  assert.deepEqual(filas[0], ['A', 'B', 'C']);
  assert.deepEqual(filas[1], ['1', 'texto; con separador', '3']);
  assert.deepEqual(filas[2], ['4', 'comilla "doble"', '6']);
});

// --- Correlacion -----------------------------------------------------------

test('pearson reconoce relacion perfecta, inversa y nula', () => {
  assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  // Serie constante: no hay correlacion que medir, y devolver 0 seria mentir.
  assert.equal(pearson([1, 2, 3], [5, 5, 5]), null);
  assert.equal(pearson([1], [2]), null);
});

test('spearman aguanta un valor atipico que a pearson lo tumba', () => {
  // Series monotonas pero con un mes disparatado, que en comercio es lo normal.
  const xs = [1, 2, 3, 4, 5, 6];
  const ys = [1, 2, 3, 4, 5, 500];
  assert.equal(spearman(xs, ys), 1, 'el orden se respeta, asi que spearman es 1');
  assert.ok(pearson(xs, ys) < 1, 'pearson se resiente del valor extremo');
});

test('spearman reparte rango medio en los empates', () => {
  // Sin rango medio, los empates inflarian la correlacion.
  assert.equal(spearman([1, 1, 2, 3], [1, 1, 2, 3]), 1);
});

test('el umbral de fiabilidad esta en 12 periodos', () => {
  // Con cuatro meses no hay correlacion, hay ruido. El numero vive en un solo
  // sitio para que la API y la documentacion no se contradigan.
  assert.equal(MIN_RELIABLE_PERIODS, 12);
});
