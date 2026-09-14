/**
 * Datos de demostracion: buques ficticios navegando entre puertos del seed.
 *
 * Sirve para ver el visor y probar la API sin depender de una clave AIS ni de
 * esperar semanas a que se acumule histórico propio. NO uses esta base de datos
 * para nada real: los MMSI son inventados y las posiciones tambien.
 *
 *   node scripts/demo.js
 */
import { query, withTransaction, closePool } from '../src/db.js';
import { loadPortIndex } from '../src/core/portIndex.js';
import { processPosition } from '../src/core/callDetector.js';
import { ensurePartitions } from '../src/jobs/partitions.js';
import { findSeaRoute } from '../src/core/seaRoute.js';
import { flagFromMmsi } from '../src/lib/mid.js';

const HOUR = 3600_000;

/**
 * Cada buque tiene SU ruta y hace viajes de ida y vuelta por ella.
 *
 * No se reparten buques entre rutas a proposito. Si un buque termina un viaje
 * en Hong Kong y su siguiente posicion es Cartagena, el recorrido dibuja una
 * recta entre ambas que cruza Ormuz, la India y media Africa: un buque de
 * verdad no se teletransporta, y la demo tampoco debe hacerlo.
 */
const FLEET = [
  { mmsi: 538900001, name: 'DEMO CLIPPER',  type: 70, from: 'NLRTM', to: 'DEHAM', voyages: 3, hours: [18, 30, 20] },
  { mmsi: 636900002, name: 'DEMO MERIDIAN', type: 74, from: 'SGSIN', to: 'HKHKG', voyages: 3, hours: [62, 55, 70] },
  { mmsi: 352900003, name: 'DEMO ATLAS',    type: 80, from: 'COCTG', to: 'NLRTM', voyages: 3, hours: [372, 400, 385] },
  { mmsi: 477900004, name: 'DEMO PIONEER',  type: 71, from: 'COBUN', to: 'CNSHA', voyages: 2, hours: [700, 730] },
  { mmsi: 249900005, name: 'DEMO HORIZON',  type: 84, from: 'AEJEA', to: 'INNSA', voyages: 3, hours: [78, 84, 80] },
  { mmsi: 563900006, name: 'DEMO AURORA',   type: 79, from: 'ESALG', to: 'ESVLC', voyages: 2, hours: [26, 31] },
  { mmsi: 219900007, name: 'DEMO NORDIC',   type: 89, from: 'USLAX', to: 'JPYOK', voyages: 1, hours: [240] },
  { mmsi: 416900008, name: 'DEMO PACIFIC',  type: 70, from: 'COBAQ', to: 'USHOU', voyages: 3, hours: [96, 104, 99] },
];

/**
 * Mete puntos intermedios en una polilinea hasta acercarse a `target`, SIN
 * quitar ninguno de los originales.
 *
 * Conservar todos los vertices no es un detalle: la ruta de mar viene
 * verificada tramo a tramo, y cada vertice es un quiebro que esquiva una costa.
 * Repartir los puntos por distancia total, como se hacia antes, se saltaba
 * vertices en las rutas con muchos recodos y el barco cortaba por tierra en
 * cada curva.
 */
function densify(points, target) {
  const segLen = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], angleDelta(points[i][1], points[i - 1][1]));
    segLen.push(d);
    total += d;
  }
  if (total === 0 || points.length >= target) return points.map((p) => [p[0], p[1]]);

  const extra = target - points.length; // cuantos hay que insertar
  const out = [[points[0][0], points[0][1]]];

  for (let i = 0; i < segLen.length; i += 1) {
    const add = Math.round((extra * segLen[i]) / total);
    for (let k = 1; k <= add; k += 1) {
      const t = k / (add + 1);
      const lat = points[i][0] + (points[i + 1][0] - points[i][0]) * t;
      let lon = points[i][1] + angleDelta(points[i + 1][1], points[i][1]) * t;
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      out.push([lat, lon]);
    }
    out.push([points[i + 1][0], points[i + 1][1]]);
  }
  return out;
}

/** Diferencia de longitudes por el camino corto. */
function angleDelta(to, from) {
  let d = to - from;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

async function main() {
  // La travesia mas larga de la flota marca cuanto hay que retroceder, y con
  // ello que particiones mensuales hacen falta.
  const maxHours = Math.max(...FLEET.map((s) => s.hours.reduce((a, b) => a + b, 0) * 2 + 100));
  for (let back = 0; back <= Math.ceil(maxHours / 24 / 28) + 1; back += 1) {
    await ensurePartitions(new Date(Date.now() - back * 28 * 24 * HOUR));
  }

  const portIndex = await loadPortIndex();
  if (portIndex.size === 0) throw new Error('No hay puertos: ejecuta "npm run seed" primero.');

  for (const s of FLEET) {
    await query(
      `INSERT INTO vessels (mmsi, imo, name, ship_type_code, ship_type_label, flag)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mmsi) DO UPDATE SET name = EXCLUDED.name`,
      [s.mmsi, 9500000 + (s.mmsi % 1000), s.name, s.type, s.type < 80 ? 'Cargo' : 'Tanker', flagFromMmsi(s.mmsi)],
    );
  }

  const feed = (mmsi, lat, lon, at, sog, navStatus) =>
    withTransaction((c) =>
      processPosition(c, portIndex, { mmsi, recordedAt: at, lat, lon, sog, cog: 90, navStatus }),
    );

  const declareDraught = (mmsi, at, draughtM) =>
    query(
      `INSERT INTO vessel_draught_reports (mmsi, reported_at, draught_m)
       VALUES ($1, $2, $3) ON CONFLICT (mmsi, reported_at) DO NOTHING`,
      [mmsi, at, draughtM],
    );

  const portOf = (code) => {
    const p = portIndex.ports.find((x) => x.unlocode === code);
    if (!p) throw new Error(`Puerto ${code} no esta en el seed`);
    return p;
  };

  let positions = 0;
  let shipIdx = 0;

  for (const ship of FLEET) {
    const a = portOf(ship.from);
    const b = portOf(ship.to);
    shipIdx += 1;

    // Cada buque arranca lo bastante atras para que TODA su historia quepa
    // antes de ahora. Con un origen comun, los buques de travesias largas
    // (700 h por viaje) generaban posiciones con fecha futura, que despues
    // quedaban fuera de cualquier consulta de "ultimos N dias".
    let totalHours = 0;
    for (let v = 0; v < ship.voyages; v += 1) {
      const h = ship.hours[v % ship.hours.length];
      totalHours += h + 16; // travesia + tiempo en puerto
      if (v < ship.voyages - 1) totalHours += Math.round(h * 0.95) + 16;
    }
    let t = new Date(Date.now() - (totalHours + shipIdx * 6) * HOUR);

    // El calado va cambiando: zarpa cargado y descarga al llegar. Es lo que
    // luego se lee como draught_delta en cada escala.
    const laden = Number((11.4 + shipIdx * 0.1).toFixed(1));
    const ballast = Number((laden - 3.8).toFixed(1));

    /** Un trayecto completo de puerto a puerto, por el camino de mar real. */
    async function sail(fromPort, toPort, transitHours, departureDraught) {
      // Amarrado en origen, con el calado de salida ya declarado.
      await declareDraught(ship.mmsi, new Date(t.getTime() - HOUR), departureDraught);
      await feed(ship.mmsi, fromPort.lat, fromPort.lon, t, 0.1, 'moored');
      positions += 1;
      t = new Date(t.getTime() + 5 * HOUR);

      const leg = findSeaRoute(fromPort.lat, fromPort.lon, toPort.lat, toPort.lon);
      if (!leg) throw new Error(`Sin ruta por mar entre ${fromPort.unlocode} y ${toPort.unlocode}`);

      const track = densify(leg.points, Math.max(10, Math.round(transitHours / 3)));
      for (let i = 0; i < track.length; i += 1) {
        const at = new Date(t.getTime() + (transitHours * HOUR * i) / (track.length - 1));
        await feed(ship.mmsi, track[i][0], track[i][1], at, 13.5, 'under way using engine');
        positions += 1;
      }
      t = new Date(t.getTime() + transitHours * HOUR + HOUR);

      await feed(ship.mmsi, toPort.lat, toPort.lon, t, 0.2, 'moored');
      positions += 1;
      t = new Date(t.getTime() + 10 * HOUR);
    }

    for (let v = 0; v < ship.voyages; v += 1) {
      const hours = ship.hours[v % ship.hours.length];

      await sail(a, b, hours, laden);
      // Descarga en destino: el calado baja mientras sigue atracado.
      await declareDraught(ship.mmsi, new Date(t.getTime() - 4 * HOUR), ballast);

      // Vuelta en lastre, salvo en el ultimo viaje: asi unos buques quedan en
      // puerto y otros en ruta, que es lo interesante de mirar en el visor.
      if (v < ship.voyages - 1) {
        await sail(b, a, Math.round(hours * 0.95), ballast);
        await declareDraught(ship.mmsi, new Date(t.getTime() - 4 * HOUR), laden);
      }
    }
  }

  const counts = await query(
    `SELECT (SELECT COUNT(*) FROM vessels)::int          AS buques,
            (SELECT COUNT(*) FROM vessel_positions)::int AS posiciones,
            (SELECT COUNT(*) FROM port_calls)::int       AS escalas,
            (SELECT COUNT(*) FROM vessel_draught_reports)::int AS calados,
            (SELECT COUNT(*) FROM route_legs WHERE destination_port_id IS NOT NULL)::int AS tramos_cerrados,
            (SELECT COUNT(*) FROM route_legs WHERE destination_port_id IS NULL)::int     AS tramos_abiertos`,
  );
  console.log('[demo]', counts.rows[0], `(${positions} posiciones simuladas)`);
  console.log('[demo] Datos FICTICIOS. Arranca "npm run api" y abre http://localhost:3000');
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[demo] fallo:', err.message);
    await closePool();
    process.exit(1);
  });
