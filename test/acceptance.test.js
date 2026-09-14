import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Criterios de aceptacion de la seccion 8, contra una base de datos real.
// Se ejecuta en un esquema aparte (mst_test) que se borra y recrea en cada
// pasada, para no tocar nada de los datos de trabajo.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const TEST_SCHEMA = process.env.TEST_DB_SCHEMA || 'mst_test';

if (dbUrl) {
  process.env.DATABASE_URL = dbUrl;
  process.env.DB_SCHEMA = TEST_SCHEMA;
}

const HOUR = 3600_000;
const ROTTERDAM = 'NLRTM';
const HAMBURG = 'DEHAM';

test(
  'seccion 8: escalas, tramos y estimacion de ruta de extremo a extremo',
  {
    skip: dbUrl
      ? false
      : 'Define TEST_DATABASE_URL (o DATABASE_URL) apuntando a un PostgreSQL 13+ para ejecutar esta prueba.',
  },
  async (t) => {
    // Las importaciones son dinamicas: config.js lee DB_SCHEMA al cargarse y
    // arriba lo acabamos de fijar al esquema de pruebas.
    const { query, withTransaction, quoteIdent, closePool } = await import('../src/db.js');
    const { loadPortIndex } = await import('../src/core/portIndex.js');
    const { processPosition } = await import('../src/core/callDetector.js');
    const { estimateRoute } = await import('../src/core/routes.js');
    const { getPortDwellStats, getCurrentLeg } = await import('../src/core/analytics.js');
    const { ensurePartitions, partitionNameFor, monthStart, listAttachedPartitions } = await import(
      '../src/jobs/partitions.js'
    );
    const { runRetention } = await import('../src/jobs/retention.js');
    const { interpolateGreatCircle, haversineMeters } = await import('../src/lib/geo.js');
    const { createApp } = await import('../src/api/server.js');

    t.after(async () => {
      await closePool();
    });

    // --- Puesta a punto ---------------------------------------------------

    await query(`DROP SCHEMA IF EXISTS ${quoteIdent(TEST_SCHEMA)} CASCADE`);
    await query(`CREATE SCHEMA ${quoteIdent(TEST_SCHEMA)}`);
    await query(await readFile(join(root, 'db', 'schema.sql'), 'utf8'));
    await query(await readFile(join(root, 'db', 'seed_ports.sql'), 'utf8'));

    const now = new Date();
    const base = new Date(now.getTime() - 10 * 24 * HOUR);
    const oldBase = new Date(now.getTime() - 150 * 24 * HOUR);
    await ensurePartitions(base);
    await ensurePartitions(now);
    await ensurePartitions(oldBase);

    const portIndex = await loadPortIndex();
    const rotterdam = portIndex.ports.find((p) => p.unlocode === ROTTERDAM);
    const hamburg = portIndex.ports.find((p) => p.unlocode === HAMBURG);
    assert.ok(rotterdam && hamburg, 'los dos puertos del seed deben existir');

    const feed = (mmsi, lat, lon, at, extra = {}) =>
      withTransaction((client) =>
        processPosition(client, portIndex, {
          mmsi,
          recordedAt: at,
          lat,
          lon,
          sog: extra.sog ?? 12.5,
          cog: extra.cog ?? 90,
          navStatus: extra.navStatus ?? 'under way using engine',
        }),
      );

    const addVessel = (mmsi, name, code = 70) =>
      query(
        `INSERT INTO vessels (mmsi, imo, name, ship_type_code, ship_type_label, flag)
         VALUES ($1, $2, $3, $4, $5, 'MH')`,
        [mmsi, 9000000 + (mmsi % 1000), name, code, code < 80 ? 'Cargo' : 'Tanker'],
      );

    const pointAlong = (fraction) =>
      interpolateGreatCircle(rotterdam.lat, rotterdam.lon, hamburg.lat, hamburg.lon, fraction);

    /**
     * Viaje completo Rotterdam -> Hamburgo. Devuelve los instantes clave y los
     * eventos que produjo la maquina de estados.
     */
    const rowById = async (table, id) =>
      (await query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];

    async function sailRotterdamToHamburg(mmsi, startAt, transitHours) {
      const events = { arrival: null, departure: null, underway: [], finalArrival: null };
      // Estado capturado EN CADA MOMENTO del viaje: los criterios de la seccion
      // 8 hablan de como queda la fila justo tras cada evento, no al final.
      const snapshots = {};

      // 1. Llegada a Rotterdam, sobre el centroide -> atracado.
      events.arrival = await feed(mmsi, rotterdam.lat, rotterdam.lon, startAt, { sog: 0.1, navStatus: 'moored' });
      const openedCallId = events.arrival.events.find((e) => e.type === 'port_call_opened')?.portCallId;
      snapshots.callAfterArrival = openedCallId ? await rowById('port_calls', openedCallId) : null;
      // Sigue amarrado: no debe pasar nada nuevo.
      const stillThere = await feed(mmsi, rotterdam.lat + 0.002, rotterdam.lon, new Date(startAt.getTime() + 2 * HOUR), {
        sog: 0,
        navStatus: 'moored',
      });
      assert.deepEqual(stillThere.events, [], 'estar quieto en el muelle no genera eventos');

      // 2. Salida: primera posicion fuera del radio de Rotterdam.
      const departedAt = new Date(startAt.getTime() + 4 * HOUR);
      const [dLat, dLon] = pointAlong(0.08);
      assert.ok(
        haversineMeters(dLat, dLon, rotterdam.lat, rotterdam.lon) > rotterdam.approach_radius_m,
        'el punto de salida debe caer fuera del radio de aproximacion',
      );
      events.departure = await feed(mmsi, dLat, dLon, departedAt);
      const closedCallId = events.departure.events.find((e) => e.type === 'port_call_closed')?.portCallId;
      const openedLegId = events.departure.events.find((e) => e.type === 'route_leg_opened')?.routeLegId;
      snapshots.callAfterDeparture = closedCallId ? await rowById('port_calls', closedCallId) : null;
      snapshots.legAfterDeparture = openedLegId ? await rowById('route_legs', openedLegId) : null;

      // 3. Travesia: puntos intermedios en mar abierto.
      const steps = 12;
      for (let i = 1; i <= steps; i += 1) {
        const f = 0.08 + ((0.92 - 0.08) * i) / (steps + 1);
        const [lat, lon] = pointAlong(f);
        assert.equal(
          portIndex.findEnclosing(lat, lon),
          null,
          `el punto intermedio ${i} no debe caer dentro de ningun puerto`,
        );
        const at = new Date(departedAt.getTime() + (transitHours * HOUR * i) / (steps + 1));
        events.underway.push(await feed(mmsi, lat, lon, at));
      }

      // 4. Llegada a Hamburgo, sobre el centroide.
      const arrivedAt = new Date(departedAt.getTime() + transitHours * HOUR);
      events.finalArrival = await feed(mmsi, hamburg.lat, hamburg.lon, arrivedAt, { sog: 0.2, navStatus: 'moored' });

      return { ...events, snapshots, startAt, departedAt, arrivedAt };
    }

    await t.test('las particiones se crean en el esquema activo, no en otro', async () => {
      // Si la base ya tiene una instalacion en "public", un to_regclass sin
      // cualificar encuentra la particion de alla y no crea la de aqui: la
      // primera posicion falla con "no partition of relation".
      const expected = partitionNameFor(monthStart(now));
      const { rows } = await query(
        `SELECT n.nspname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = $2`,
        [expected, TEST_SCHEMA],
      );
      assert.equal(rows.length, 1, `${expected} deberia existir en ${TEST_SCHEMA}`);
    });

    // --- Criterio 1: al llegar se abre una escala sin departed_at ----------

    const MMSI_A = 538000101;
    await addVessel(MMSI_A, 'TEST CARGO A');
    const voyageA = await sailRotterdamToHamburg(MMSI_A, base, 18);

    await t.test('al llegar se abre un port_call con departed_at = NULL', async () => {
      const opened = voyageA.arrival.events.find((e) => e.type === 'port_call_opened');
      assert.ok(opened, 'deberia haberse abierto una escala');
      assert.equal(opened.portId, rotterdam.id);
      assert.equal(opened.callType, 'berth', 'sobre el centroide el buque cuenta como atracado');

      // Estado de la fila justo despues de llegar, antes de volver a zarpar.
      const call = voyageA.snapshots.callAfterArrival;
      assert.equal(call.departed_at, null, 'la escala recien abierta no tiene salida');
      assert.equal(Number(call.mmsi), MMSI_A);
      assert.equal(call.port_id, rotterdam.id);
      assert.equal(call.call_type, 'berth');
      assert.deepEqual(call.arrived_at, voyageA.startAt);
      assert.equal(call.id, opened.portCallId);
    });

    // --- Criterio 2: al salir se cierra la escala y se abre el tramo -------

    await t.test('al salir del radio se cierra la escala y se abre un route_leg', async () => {
      const closed = voyageA.departure.events.find((e) => e.type === 'port_call_closed');
      const openedLeg = voyageA.departure.events.find((e) => e.type === 'route_leg_opened');
      assert.ok(closed, 'deberia haberse cerrado la escala');
      assert.ok(openedLeg, 'deberia haberse abierto el tramo');

      // La escala queda cerrada con la marca de tiempo de ESTA posicion.
      const call = voyageA.snapshots.callAfterDeparture;
      assert.equal(call.id, closed.portCallId);
      assert.deepEqual(call.departed_at, voyageA.departedAt);

      // Y el tramo nace con origen correcto y destino todavia sin resolver.
      const leg = voyageA.snapshots.legAfterDeparture;
      assert.equal(leg.id, openedLeg.routeLegId);
      assert.equal(leg.origin_port_id, rotterdam.id);
      assert.equal(leg.destination_port_id, null);
      assert.equal(leg.arrived_at, null);
      assert.equal(leg.transit_seconds, null);
      assert.equal(leg.path_points, null);
      assert.deepEqual(leg.departed_at, voyageA.departedAt);
    });

    await t.test('navegar en mar abierto no genera eventos', () => {
      for (const step of voyageA.underway) assert.deepEqual(step.events, []);
    });

    // --- Criterio 3: al llegar al segundo puerto se cierra el tramo --------

    await t.test('el route_leg se cierra con transit_seconds real y path_points no vacio', async () => {
      const closedLeg = voyageA.finalArrival.events.find((e) => e.type === 'route_leg_closed');
      assert.ok(closedLeg, 'deberia haberse cerrado el tramo');
      assert.equal(closedLeg.destinationPortId, hamburg.id);

      const expectedSeconds = (voyageA.arrivedAt.getTime() - voyageA.departedAt.getTime()) / 1000;
      assert.equal(closedLeg.transitSeconds, expectedSeconds);
      assert.equal(expectedSeconds, 18 * 3600);

      const { rows } = await query('SELECT * FROM route_legs WHERE id = $1', [closedLeg.routeLegId]);
      const leg = rows[0];
      assert.equal(leg.transit_seconds, expectedSeconds);
      assert.deepEqual(leg.arrived_at, voyageA.arrivedAt);

      assert.ok(Array.isArray(leg.path_points) && leg.path_points.length > 0, 'path_points no puede estar vacio');
      // salida + 12 intermedios + llegada
      assert.equal(leg.path_points.length, 14);
      for (const p of leg.path_points) assert.equal(p.length, 3, '[lat, lon, timestamp]');

      const [firstLat, firstLon, firstTs] = leg.path_points[0];
      assert.equal(new Date(firstTs).getTime(), voyageA.departedAt.getTime());
      assert.ok(haversineMeters(firstLat, firstLon, rotterdam.lat, rotterdam.lon) > rotterdam.approach_radius_m);

      const [lastLat, lastLon, lastTs] = leg.path_points.at(-1);
      assert.equal(new Date(lastTs).getTime(), voyageA.arrivedAt.getTime());
      assert.ok(Math.abs(lastLat - hamburg.lat) < 1e-9 && Math.abs(lastLon - hamburg.lon) < 1e-9);

      // Y ademas queda abierta la escala en el puerto de destino.
      const openedAtDest = voyageA.finalArrival.events.find((e) => e.type === 'port_call_opened');
      assert.ok(openedAtDest);
      assert.equal(openedAtDest.portId, hamburg.id);
    });

    // --- Criterio 4: great_circle con < 3 tramos, historical con >= 3 ------

    // NOTA: la especificacion original pedia 'great_circle' aqui. Se cambio por
    // decision expresa posterior: una linea de gran circulo entre dos puertos es
    // la ruta de un avion y cruza continentes. Ahora se calcula un camino
    // navegable y 'great_circle' queda solo como ultimo recurso si el enrutado
    // falla. El umbral de 3 tramos para pasar a historica no ha cambiado.
    await t.test('con 1 tramo historico la ruta se calcula por mar', async () => {
      const route = await estimateRoute(rotterdam.id, hamburg.id);
      assert.equal(route.source, 'sea_route');
      assert.equal(route.legs_considered, 1);
      assert.equal(route.transit_seconds, null);
      assert.ok(route.transit_note.includes('3 tramos'));
      assert.ok(route.distance_nm > 0);
      assert.ok(route.routing_note.includes('rejilla de mar'));
      for (const p of route.path_points) assert.equal(p.length, 2, 'el camino calculado no lleva marca de tiempo');
      assert.ok(Math.abs(route.path_points[0][0] - rotterdam.lat) < 1e-9);
      assert.ok(Math.abs(route.path_points.at(-1)[1] - hamburg.lon) < 1e-9);
    });

    const MMSI_B = 538000102;
    const MMSI_C = 538000103;
    await addVessel(MMSI_B, 'TEST CARGO B', 71);
    await addVessel(MMSI_C, 'TEST TANKER C', 80);
    const voyageB = await sailRotterdamToHamburg(MMSI_B, new Date(base.getTime() + 24 * HOUR), 30);
    await t.test('con 2 tramos historicos sigue sin ser historica', async () => {
      const route = await estimateRoute(rotterdam.id, hamburg.id);
      assert.equal(route.source, 'sea_route');
      assert.equal(route.legs_considered, 2);
    });

    const voyageC = await sailRotterdamToHamburg(MMSI_C, new Date(base.getTime() + 48 * HOUR), 20);

    await t.test('con 3 tramos historicos la ruta pasa a ser historica', async () => {
      const route = await estimateRoute(rotterdam.id, hamburg.id);
      assert.equal(route.source, 'historical');
      assert.equal(route.legs_considered, 3);

      // Duraciones 18 h, 30 h y 20 h -> la mediana es 20 h: gana el viaje C.
      assert.equal(route.transit_seconds, 20 * 3600);
      assert.equal(route.based_on_leg.mmsi, MMSI_C);
      assert.ok(route.path_points.length > 0);
      for (const p of route.path_points) assert.equal(p.length, 3, 'la traza historica lleva marca de tiempo');

      assert.equal(route.transit_stats.legs, 3);
      assert.equal(route.transit_stats.min_transit_seconds, 18 * 3600);
      assert.equal(route.transit_stats.max_transit_seconds, 30 * 3600);
      assert.equal(route.transit_stats.median_transit_seconds, 20 * 3600);
      assert.ok(Math.abs(route.transit_stats.avg_transit_seconds - ((18 + 30 + 20) / 3) * 3600) < 1);
      assert.equal(route.transit_note, undefined);
    });

    await t.test('la ruta inversa todavia no tiene historico propio', async () => {
      const back = await estimateRoute(hamburg.id, rotterdam.id);
      assert.equal(back.source, 'sea_route');
      assert.equal(back.legs_considered, 0);
      assert.equal(back.transit_stats.legs, 0);
    });

    // --- Fondeo frente a atraque ------------------------------------------

    await t.test('llegar lejos del centroide se clasifica como fondeo', async () => {
      const MMSI_D = 538000104;
      await addVessel(MMSI_D, 'TEST CARGO D', 79);
      // ~9 km al norte del centro: dentro del radio de 15 km, mas alla del 30%.
      const lat = rotterdam.lat + 0.081;
      const distance = haversineMeters(lat, rotterdam.lon, rotterdam.lat, rotterdam.lon);
      assert.ok(distance > 0.3 * rotterdam.approach_radius_m && distance < rotterdam.approach_radius_m);

      const res = await feed(MMSI_D, lat, rotterdam.lon, new Date(base.getTime() + 72 * HOUR), {
        sog: 0.3,
        navStatus: 'at anchor',
      });
      const opened = res.events.find((e) => e.type === 'port_call_opened');
      assert.equal(opened.callType, 'anchorage');
    });

    // --- 4.4 Permanencia por puerto ---------------------------------------

    await t.test('la permanencia media del puerto solo cuenta escalas cerradas', async () => {
      const stats = await getPortDwellStats(rotterdam.id);
      const berth = stats.find((s) => s.call_type === 'berth');
      assert.equal(berth.calls, 3, 'las tres escalas cerradas en Rotterdam');
      assert.equal(berth.avg_dwell_seconds, 4 * 3600);

      // El fondeo de MMSI_D sigue abierto: no aparece en las estadisticas.
      assert.equal(stats.find((s) => s.call_type === 'anchorage'), undefined);

      // En Hamburgo las tres escalas siguen abiertas: aun no hay estadistica.
      assert.deepEqual(await getPortDwellStats(hamburg.id), []);
    });

    // --- Tramo en curso ----------------------------------------------------

    let mmsiEnRuta;
    await t.test('un buque que salio y no ha llegado tiene tramo en curso', async () => {
      mmsiEnRuta = 538000105;
      await addVessel(mmsiEnRuta, 'TEST CARGO E');
      const start = new Date(base.getTime() + 96 * HOUR);
      await feed(mmsiEnRuta, rotterdam.lat, rotterdam.lon, start, { sog: 0, navStatus: 'moored' });
      const [lat, lon] = pointAlong(0.2);
      await feed(mmsiEnRuta, lat, lon, new Date(start.getTime() + 3 * HOUR));

      const leg = await getCurrentLeg(mmsiEnRuta);
      assert.ok(leg, 'deberia haber un tramo en curso');
      assert.equal(leg.origin_port_id, rotterdam.id);
      assert.equal(leg.origin_unlocode, ROTTERDAM);
      assert.ok(leg.elapsed_seconds > 0);

      // Y el buque A, que si llego, no tiene tramo abierto.
      assert.equal(await getCurrentLeg(MMSI_A), null);
    });

    // --- Seccion 7: retencion y archivado ----------------------------------

    await t.test('la retencion resume y desconecta la particion vieja sin borrarla', async () => {
      const MMSI_OLD = 538000106;
      await addVessel(MMSI_OLD, 'TEST CARGO OLD');
      const oldPartition = partitionNameFor(monthStart(oldBase));

      // Dos dias de posiciones en un mes muy anterior a la ventana de retencion.
      // Lejos de cualquier puerto, para no mezclar escalas en esta prueba.
      const day1 = new Date(Date.UTC(oldBase.getUTCFullYear(), oldBase.getUTCMonth(), 5, 0, 0, 0));
      const day2 = new Date(day1.getTime() + 24 * HOUR);
      for (const [i, at] of [day1, new Date(day1.getTime() + 12 * HOUR), day2].entries()) {
        await query(
          `INSERT INTO vessel_positions (mmsi, recorded_at, lat, lon, sog, cog, nav_status)
           VALUES ($1, $2, $3, $4, $5, 90, 'under way using engine')`,
          [MMSI_OLD, at, 20 + i * 0.5, -40, 11 + i],
        );
      }

      const before = await listAttachedPartitions();
      assert.ok(before.some((p) => p.name === oldPartition), 'la particion vieja deberia estar adjunta');

      const result = await runRetention({ now, retentionDays: 90 });
      const archived = result.archived.find((a) => a.partition === oldPartition);
      assert.ok(archived, `deberia haberse archivado ${oldPartition}`);
      assert.equal(archived.archivedAs, `${oldPartition}_archived`);

      // Desconectada del padre...
      const after = await listAttachedPartitions();
      assert.ok(!after.some((p) => p.name === oldPartition));
      // ...renombrada, y con los datos intactos: el borrado es manual.
      const { rows: kept } = await query(
        `SELECT COUNT(*)::int AS n FROM ${quoteIdent(`${oldPartition}_archived`)}`,
      );
      assert.equal(kept[0].n, 3, 'la particion archivada conserva sus filas');

      // Y quedo el resumen diario.
      const { rows: summary } = await query(
        'SELECT * FROM vessel_daily_summary WHERE mmsi = $1 ORDER BY summary_date',
        [MMSI_OLD],
      );
      assert.equal(summary.length, 2, 'dos dias resumidos');
      assert.equal(summary[0].positions_count, 2);
      assert.ok(summary[0].distance_nm > 0);
      assert.equal(Number(summary[0].avg_sog), 11.5);

      // Las particiones recientes siguen en su sitio.
      assert.ok(after.some((p) => p.name === partitionNameFor(monthStart(now))));
    });

    // --- API ----------------------------------------------------------------

    await t.test('la API responde los cinco endpoints de la seccion 5', async () => {
      const app = createApp();
      const server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      const port = server.address().port;
      const get = async (path) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        return { status: res.status, body: await res.json() };
      };

      try {
        const vessels = await get('/vessels');
        assert.equal(vessels.status, 200);
        assert.ok(vessels.body.vessels.length >= 5);
        const a = vessels.body.vessels.find((v) => v.mmsi === MMSI_A);
        assert.equal(a.ship_type_label, 'Cargo');
        assert.ok(a.last_position, 'cada buque trae su posicion mas reciente');
        assert.ok(Math.abs(a.last_position.lat - hamburg.lat) < 1e-9);

        const tankers = await get('/vessels?type=Tanker');
        assert.ok(tankers.body.vessels.every((v) => v.ship_type_label === 'Tanker'));
        assert.equal((await get('/vessels?type=Passenger')).status, 400);

        // Calado: sin declararlo, no se infiere nada. Es lo correcto.
        const sinCalado = await get(`/vessels/${MMSI_A}/dwell`);
        assert.equal(sinCalado.body.cargo_operations.draught_change.available, false);

        // Con calado declarado en llegada y salida, sale la direccion y el delta.
        await query(
          `INSERT INTO vessel_draught_reports (mmsi, reported_at, draught_m) VALUES ($1, $2, $3)`,
          [MMSI_B, new Date(base.getTime() + 23 * HOUR), 12.4],
        );
        // getVesselDwell devuelve la escala MAS RECIENTE, que es la de destino.
        await query(
          `UPDATE port_calls SET draught_on_arrival = 8.6, draught_on_departure = 12.4
            WHERE id = (SELECT id FROM port_calls WHERE mmsi = $1 ORDER BY arrived_at DESC LIMIT 1)`,
          [MMSI_B],
        );
        const conCalado = await get(`/vessels/${MMSI_B}/dwell`);
        const dc = conCalado.body.cargo_operations.draught_change;
        assert.equal(dc.available, true);
        assert.equal(dc.draught_delta_m, 3.8);
        assert.equal(dc.direction, 'loaded');
        assert.equal(dc.is_inference, true);
        assert.equal(dc.tonnes, undefined, 'el AIS no da toneladas y no debe aparecer ninguna');

        const dwell = await get(`/vessels/${MMSI_A}/dwell`);
        assert.equal(dwell.status, 200);
        assert.equal(dwell.body.port_call.port.unlocode, HAMBURG);
        assert.equal(dwell.body.port_call.call_type, 'berth');
        assert.equal(dwell.body.port_call.is_open, true);
        assert.equal(dwell.body.cargo_operations.available, false);
        assert.ok(dwell.body.cargo_operations.likely_working_window.is_open);

        const leg = await get(`/vessels/${mmsiEnRuta}/current-leg`);
        assert.equal(leg.body.current_leg.origin_port.unlocode, ROTTERDAM);
        assert.equal(leg.body.current_leg.destination_port, null);
        assert.equal((await get(`/vessels/${MMSI_A}/current-leg`)).body.current_leg, null);

        // Cuatro escalas cerradas en Rotterdam: A, B y C de 4 h, y la del buque
        // que sigue en ruta, de 3 h -> media 3,75 h.
        // Recorrido observado: posiciones crudas, no ruta estimada.
        const track = await get(`/vessels/${MMSI_A}/track?days=30`);
        assert.equal(track.status, 200);
        assert.ok(track.body.positions_in_window > 0);
        assert.equal(track.body.points_returned, track.body.track.length);
        assert.equal(track.body.downsampled, false);
        for (const p of track.body.track) assert.equal(p.length, 3, '[lat, lon, timestamp]');
        assert.ok(track.body.distance_nm > 0);
        // Termina donde esta el buque ahora.
        const [lastLat, lastLon] = track.body.track.at(-1);
        assert.ok(Math.abs(lastLat - hamburg.lat) < 1e-9 && Math.abs(lastLon - hamburg.lon) < 1e-9);

        // Ventana sin observaciones: se dice, no se devuelve un hueco mudo.
        const empty = await get(`/vessels/${MMSI_A}/track?days=1`);
        assert.equal(empty.body.positions_in_window, 0);
        assert.match(empty.body.coverage_note, /Sin posiciones guardadas/);

        // days fuera de rango se acota en vez de fallar.
        assert.equal((await get(`/vessels/${MMSI_A}/track?days=9999`)).body.window.days, 365);
        assert.equal((await get(`/vessels/${MMSI_A}/track?days=abc`)).body.window.days, 30);
        assert.equal((await get('/vessels/999999999/track')).status, 404);

        // --- Correlacion con documentacion aduanera -----------------------
        // Escalas en una ventana de fechas: lo que se cruza con la fecha de
        // llegada de una declaracion de importacion.
        const desde = new Date(base.getTime() - 24 * HOUR).toISOString();
        const hasta = new Date(base.getTime() + 200 * HOUR).toISOString();
        const calls = await get(`/ports/${rotterdam.id}/calls?from=${desde}&to=${hasta}`);
        assert.equal(calls.status, 200);
        assert.ok(calls.body.calls.length >= 4, 'deberian verse las escalas de la ventana');
        assert.ok(calls.body.calls.every((c) => c.imo && c.name));
        assert.match(calls.body.correlation_note, /no el buque de un envio concreto/);

        // Solo atracadas: el fondeo del buque D no debe salir.
        const soloBerth = await get(`/ports/${rotterdam.id}/calls?from=${desde}&to=${hasta}&type=berth`);
        assert.ok(soloBerth.body.calls.every((c) => c.call_type === 'berth'));
        assert.equal((await get(`/ports/${rotterdam.id}/calls?type=cualquiera`)).status, 400);
        assert.equal((await get(`/ports/${rotterdam.id}/calls?from=2030-01-01&to=2020-01-01`)).status, 400);

        // Serie agregada por periodo, que es lo que se correlaciona.
        const traffic = await get(`/ports/${hamburg.id}/traffic?from=${desde}&to=${hasta}&bucket=month`);
        assert.equal(traffic.status, 200);
        assert.ok(traffic.body.traffic.length >= 1);
        assert.ok(traffic.body.traffic.every((t) => t.calls > 0 && t.vessels > 0));
        assert.match(traffic.body.measures_note, /NO carga movida/);

        // Los tres viajes llegaron a Hamburgo desde Rotterdam.
        const desdeRotterdam = traffic.body.arrivals_by_origin.find(
          (o) => o.origin_unlocode === ROTTERDAM,
        );
        assert.ok(desdeRotterdam, 'Rotterdam deberia figurar como origen');
        assert.equal(desdeRotterdam.arrivals, 3);

        // Busqueda por IMO y por nombre, para llegar desde un documento de transporte.
        const porImo = await get(`/vessels?q=${9000000 + (MMSI_A % 1000)}`);
        assert.equal(porImo.body.vessels[0].mmsi, MMSI_A);
        const porNombre = await get('/vessels?q=TEST%20CARGO%20A');
        assert.equal(porNombre.body.vessels[0].mmsi, MMSI_A);
        assert.deepEqual((await get('/vessels?q=NO_EXISTE_ESTE_BUQUE')).body.vessels, []);

        const ds = await get(`/ports/${rotterdam.id}/dwell-stats`);
        assert.equal(ds.body.dwell_stats.berth.calls, 4);
        assert.equal(ds.body.dwell_stats.berth.avg_dwell_hours, 3.75);
        // El fondeo del buque D sigue abierto: no entra en la estadistica.
        assert.equal(ds.body.dwell_stats.anchorage.calls, 0);

        const route = await get(`/routes/${rotterdam.id}/${hamburg.id}`);
        assert.equal(route.body.source, 'historical');
        assert.equal(route.body.transit_seconds, 20 * 3600);

        // Seccion 4.3: el dato de carga se declara no disponible.
        const cargo = await get(`/vessels/${MMSI_A}/cargo-operations`);
        assert.equal(cargo.status, 501);
        assert.equal(cargo.body.cargo_operations.available, false);
        assert.match(cargo.body.cargo_operations.message, /no esta disponible en esta fase/);

        assert.equal((await get('/vessels/999999999/dwell')).status, 404);
        assert.equal((await get('/ports/99999/dwell-stats')).status, 404);
        assert.equal((await get('/no-existe')).status, 404);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    await t.test('los tres viajes quedaron cerrados y sin estado colgando', async () => {
      const { rows } = await query(
        `SELECT mmsi, transit_seconds FROM route_legs
          WHERE destination_port_id = $1 AND origin_port_id = $2
          ORDER BY mmsi`,
        [hamburg.id, rotterdam.id],
      );
      assert.deepEqual(
        rows.map((r) => [r.mmsi, r.transit_seconds]),
        [
          [MMSI_A, 18 * 3600],
          [MMSI_B, 30 * 3600],
          [MMSI_C, 20 * 3600],
        ],
      );
      assert.equal(voyageB.departedAt.getTime(), voyageB.startAt.getTime() + 4 * HOUR);
      assert.equal(voyageC.arrivedAt.getTime(), voyageC.departedAt.getTime() + 20 * HOUR);

      // Ningun buque puede tener a la vez escala abierta y tramo abierto.
      const { rows: overlap } = await query(
        `SELECT c.mmsi FROM port_calls c
           JOIN route_legs l ON l.mmsi = c.mmsi AND l.destination_port_id IS NULL
          WHERE c.departed_at IS NULL`,
      );
      assert.deepEqual(overlap, []);
    });
  },
);
