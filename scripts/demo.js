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

const HOUR = 3600_000;

// origen, destino, cuantos viajes completos y cuantas horas dura cada travesia
const ROUTES = [
  { from: 'NLRTM', to: 'DEHAM', voyages: 3, hours: [18, 30, 20] },
  { from: 'SGSIN', to: 'HKHKG', voyages: 3, hours: [62, 55, 70] },
  { from: 'COCTG', to: 'NLRTM', voyages: 3, hours: [372, 400, 385] },
  { from: 'COBUN', to: 'CNSHA', voyages: 2, hours: [700, 730] },
  { from: 'ESALG', to: 'ESVLC', voyages: 2, hours: [26, 31] },
  { from: 'USLAX', to: 'JPYOK', voyages: 1, hours: [240] },
];

const SHIPS = [
  { mmsi: 538900001, name: 'DEMO CLIPPER', type: 70 },
  { mmsi: 636900002, name: 'DEMO MERIDIAN', type: 74 },
  { mmsi: 352900003, name: 'DEMO ATLAS', type: 80 },
  { mmsi: 477900004, name: 'DEMO PIONEER', type: 71 },
  { mmsi: 249900005, name: 'DEMO HORIZON', type: 84 },
  { mmsi: 563900006, name: 'DEMO AURORA', type: 79 },
  { mmsi: 219900007, name: 'DEMO NORDIC', type: 89 },
  { mmsi: 416900008, name: 'DEMO PACIFIC', type: 70 },
];

/**
 * Reparte `target` puntos a lo largo de una polilinea, repartidos por distancia
 * y no por vertice: si no, los tramos largos de oceano abierto se quedarian con
 * dos puntos y los recodos de los canales con veinte.
 */
function densify(points, target) {
  const segLen = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], angleDelta(points[i][1], points[i - 1][1]));
    segLen.push(d);
    total += d;
  }
  if (total === 0) return [points[0], points[points.length - 1]];

  const out = [];
  for (let k = 0; k < target; k += 1) {
    let want = (total * k) / (target - 1);
    let i = 0;
    while (i < segLen.length - 1 && want > segLen[i]) {
      want -= segLen[i];
      i += 1;
    }
    const t = segLen[i] === 0 ? 0 : want / segLen[i];
    const lat = points[i][0] + (points[i + 1][0] - points[i][0]) * t;
    let lon = points[i][1] + angleDelta(points[i + 1][1], points[i][1]) * t;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    out.push([lat, lon]);
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
  // Arrancamos hace 40 dias para que quepan varios viajes seguidos, asi que
  // hace falta tambien la particion de ese mes, no solo las del mes en curso.
  const origin = new Date(Date.now() - 40 * 24 * HOUR);
  await ensurePartitions(origin);
  await ensurePartitions();

  const portIndex = await loadPortIndex();
  if (portIndex.size === 0) throw new Error('No hay puertos: ejecuta "npm run seed" primero.');

  for (const s of SHIPS) {
    await query(
      `INSERT INTO vessels (mmsi, imo, name, ship_type_code, ship_type_label, flag)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mmsi) DO UPDATE SET name = EXCLUDED.name`,
      [s.mmsi, 9500000 + (s.mmsi % 1000), s.name, s.type, s.type < 80 ? 'Cargo' : 'Tanker',
       (await import('../src/lib/mid.js')).flagFromMmsi(s.mmsi)],
    );
  }

  const feed = (mmsi, lat, lon, at, sog, navStatus) =>
    withTransaction((c) =>
      processPosition(c, portIndex, { mmsi, recordedAt: at, lat, lon, sog, cog: 90, navStatus }),
    );

  const portOf = (code) => {
    const p = portIndex.ports.find((x) => x.unlocode === code);
    if (!p) throw new Error(`Puerto ${code} no esta en el seed`);
    return p;
  };

  let shipIdx = 0;
  let positions = 0;

  for (const route of ROUTES) {
    const a = portOf(route.from);
    const b = portOf(route.to);

    for (let v = 0; v < route.voyages; v += 1) {
      const ship = SHIPS[shipIdx % SHIPS.length];
      shipIdx += 1;
      const transitHours = route.hours[v % route.hours.length];
      let t = new Date(origin.getTime() + shipIdx * 9 * HOUR);

      // Escala en el puerto de salida.
      await feed(ship.mmsi, a.lat, a.lon, t, 0.1, 'moored');
      positions += 1;
      t = new Date(t.getTime() + 5 * HOUR);

      // Travesia por el camino de mar real: rodea continentes y pasa por los
      // canales. Antes se interpolaba un gran circulo y los buques de la demo
      // atravesaban Africa como si fueran aviones.
      const leg = findSeaRoute(a.lat, a.lon, b.lat, b.lon);
      if (!leg) throw new Error(`Sin ruta por mar entre ${route.from} y ${route.to}`);
      const track = densify(leg.points, Math.max(10, Math.round(transitHours / 3)));
      for (let i = 0; i < track.length; i += 1) {
        const at = new Date(t.getTime() + (transitHours * HOUR * i) / (track.length - 1));
        await feed(ship.mmsi, track[i][0], track[i][1], at, 13.5, 'under way using engine');
        positions += 1;
      }
      t = new Date(t.getTime() + transitHours * HOUR);

      // Llegada al destino: unas horas atracado antes del siguiente viaje.
      await feed(ship.mmsi, b.lat, b.lon, new Date(t.getTime() + HOUR), 0.2, 'moored');
      positions += 1;

      // El ultimo viaje de cada ruta se queda en puerto; los demas zarpan de
      // vuelta para que haya tambien tramos en curso que mirar.
      if (v < route.voyages - 1) {
        const back = findSeaRoute(b.lat, b.lon, a.lat, a.lon);
        const early = densify(back.points, 6)[2];
        await feed(ship.mmsi, early[0], early[1], new Date(t.getTime() + 9 * HOUR), 12.8, 'under way using engine');
        positions += 1;
      }
    }
  }

  const counts = await query(
    `SELECT (SELECT COUNT(*) FROM vessels)::int          AS buques,
            (SELECT COUNT(*) FROM vessel_positions)::int AS posiciones,
            (SELECT COUNT(*) FROM port_calls)::int       AS escalas,
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
