import { config } from '../config.js';
import { query, quoteIdent, withTransaction } from '../db.js';
import { haversineMeters, metersToNauticalMiles } from '../lib/geo.js';
import { addMonths, listAttachedPartitions } from './partitions.js';

export const ARCHIVED_SUFFIX = '_archived';

/**
 * Retencion de posiciones crudas (seccion 7).
 *
 * Para cada particion mensual cuyo mes entero ya quedo por detras de
 * RAW_RETENTION_DAYS:
 *   1. se resume en vessel_daily_summary,
 *   2. se DESCONECTA de vessel_positions (DETACH, no DROP),
 *   3. se renombra con sufijo _archived.
 *
 * El borrado definitivo es una accion manual y separada, a proposito: una vez
 * borrada la posicion cruda no se puede recalcular nada sobre ella.
 */
export async function runRetention({
  now = new Date(),
  retentionDays = config.retention.rawRetentionDays,
  dryRun = false,
} = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const partitions = await listAttachedPartitions();
  const result = { cutoff, examined: partitions.length, archived: [], skipped: [] };

  for (const p of partitions) {
    const monthEnd = addMonths(p.month, 1);
    // Solo se archiva si TODO el mes quedo fuera de la ventana de retencion.
    if (monthEnd > cutoff) {
      result.skipped.push(p.name);
      continue;
    }

    if (dryRun) {
      result.archived.push({ partition: p.name, dryRun: true });
      continue;
    }

    const summary = await summarizePartition(p.name);
    await detachAndRename(p.name);
    result.archived.push({
      partition: p.name,
      archivedAs: p.name + ARCHIVED_SUFFIX,
      ...summary,
    });
    console.log(
      `[retention] ${p.name}: ${summary.vessels} buques, ${summary.summaryRows} dias resumidos, ` +
        `${summary.positions} posiciones -> ${p.name}${ARCHIVED_SUFFIX} (desconectada, NO borrada)`,
    );
  }

  if (result.archived.length > 0) {
    console.log(
      '[retention] borrado definitivo pendiente y manual: ' +
        result.archived.map((a) => `DROP TABLE ${a.archivedAs};`).join(' '),
    );
  }
  return result;
}

/**
 * Resume una particion en vessel_daily_summary: distancia recorrida, velocidad
 * media y numero de posiciones, por buque y dia (UTC).
 *
 * La distancia se calcula con Haversine en la capa de aplicacion, encadenando
 * posiciones consecutivas DENTRO del mismo dia. El salto entre el ultimo punto
 * de un dia y el primero del siguiente no se suma a ninguno de los dos: asi
 * ningun dia se lleva millas que no navego.
 */
export async function summarizePartition(partitionName) {
  const table = quoteIdent(partitionName);
  const { rows: vessels } = await query(`SELECT DISTINCT mmsi FROM ${table} ORDER BY mmsi`);

  let summaryRows = 0;
  let positions = 0;

  for (const { mmsi } of vessels) {
    const { rows } = await query(
      `SELECT recorded_at, lat, lon, sog FROM ${table} WHERE mmsi = $1 ORDER BY recorded_at`,
      [mmsi],
    );
    positions += rows.length;

    const days = aggregateByDay(rows);
    if (days.length === 0) continue;

    await withTransaction(async (client) => {
      for (const d of days) {
        await client.query(
          `INSERT INTO vessel_daily_summary (mmsi, summary_date, distance_nm, avg_sog, positions_count)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (mmsi, summary_date) DO UPDATE SET
             distance_nm     = EXCLUDED.distance_nm,
             avg_sog         = EXCLUDED.avg_sog,
             positions_count = EXCLUDED.positions_count`,
          [mmsi, d.date, d.distanceNm, d.avgSog, d.count],
        );
      }
    });
    summaryRows += days.length;
  }

  return { vessels: vessels.length, summaryRows, positions };
}

/**
 * Agrupa posiciones ordenadas por tiempo en dias UTC.
 * @returns {{date:string, distanceNm:number, avgSog:number|null, count:number}[]}
 */
export function aggregateByDay(rows) {
  const byDay = new Map();

  for (const row of rows) {
    const at = row.recorded_at instanceof Date ? row.recorded_at : new Date(row.recorded_at);
    const key = at.toISOString().slice(0, 10);

    let day = byDay.get(key);
    if (!day) {
      day = { date: key, meters: 0, sogSum: 0, sogCount: 0, count: 0, prev: null };
      byDay.set(key, day);
    }

    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (day.prev) day.meters += haversineMeters(day.prev[0], day.prev[1], lat, lon);
    day.prev = [lat, lon];
    day.count += 1;

    if (row.sog !== null && row.sog !== undefined) {
      day.sogSum += Number(row.sog);
      day.sogCount += 1;
    }
  }

  return [...byDay.values()].map((d) => ({
    date: d.date,
    distanceNm: Number(metersToNauticalMiles(d.meters).toFixed(3)),
    avgSog: d.sogCount > 0 ? Number((d.sogSum / d.sogCount).toFixed(3)) : null,
    count: d.count,
  }));
}

/**
 * DETACH + RENAME en una transaccion. DETACH toma un lock breve sobre la tabla
 * padre; en PostgreSQL 14+ existe DETACH CONCURRENTLY, pero el objetivo aqui es
 * PostgreSQL 13+, asi que se usa la forma simple y se corre de madrugada.
 */
export async function detachAndRename(partitionName) {
  const archivedName = partitionName + ARCHIVED_SUFFIX;
  await withTransaction(async (client) => {
    await client.query(
      `ALTER TABLE vessel_positions DETACH PARTITION ${quoteIdent(partitionName)}`,
    );
    await client.query(
      `ALTER TABLE ${quoteIdent(partitionName)} RENAME TO ${quoteIdent(archivedName)}`,
    );
  });
  return archivedName;
}
