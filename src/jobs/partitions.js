import { query, quoteIdent } from '../db.js';

export const PARTITION_PREFIX = 'vessel_positions_';
/** Mes en curso + los proximos dos (seccion 7). */
export const MONTHS_AHEAD = 2;

/** Primer instante (UTC) del mes al que pertenece `date`. */
export function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function addMonths(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}

export function partitionNameFor(monthStartDate) {
  const y = monthStartDate.getUTCFullYear();
  const m = String(monthStartDate.getUTCMonth() + 1).padStart(2, '0');
  return `${PARTITION_PREFIX}${y}_${m}`;
}

/** 'YYYY-MM-DD 00:00:00+00' -- limite explicito en UTC, sin depender del TimeZone de la sesion. */
function boundLiteral(d) {
  return `${d.toISOString().slice(0, 10)} 00:00:00+00`;
}

/** Deduce el mes de una particion a partir de su nombre, o null si no encaja. */
export function monthOfPartition(name) {
  const m = name.match(/^vessel_positions_(\d{4})_(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
}

/**
 * Crea las particiones mensuales que falten: la del mes en curso y las de los
 * proximos MONTHS_AHEAD. Idempotente, pensada para correr a diario.
 */
export async function ensurePartitions(now = new Date(), monthsAhead = MONTHS_AHEAD) {
  const created = [];
  const start = monthStart(now);

  for (let i = 0; i <= monthsAhead; i += 1) {
    const from = addMonths(start, i);
    const to = addMonths(start, i + 1);
    const name = partitionNameFor(from);

    // CREATE TABLE IF NOT EXISTS devuelve el mismo command tag exista o no la
    // tabla, asi que preguntamos antes para poder informar de lo que se creo.
    const { rows } = await query('SELECT to_regclass($1) AS oid', [name]);
    if (rows[0].oid) continue;

    try {
      await query(
        `CREATE TABLE IF NOT EXISTS ${quoteIdent(name)}
           PARTITION OF vessel_positions
           FOR VALUES FROM ('${boundLiteral(from)}') TO ('${boundLiteral(to)}')`,
      );
      created.push(name);
    } catch (err) {
      // Dos procesos creando la misma particion a la vez: uno gana, el otro
      // encuentra la tabla ya hecha. No es un fallo.
      if (err.code === '42P07' || err.code === '23505') continue;
      throw err;
    }
  }
  return created;
}

/** Particiones actualmente adjuntas a vessel_positions, de mas antigua a mas nueva. */
export async function listAttachedPartitions() {
  const { rows } = await query(
    `SELECT c.relname AS name
       FROM pg_inherits i
       JOIN pg_class c      ON c.oid = i.inhrelid
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_namespace n  ON n.oid = parent.relnamespace
      WHERE parent.relname = 'vessel_positions'
        AND n.nspname = current_schema()
      ORDER BY c.relname`,
  );
  return rows
    .map((r) => ({ name: r.name, month: monthOfPartition(r.name) }))
    .filter((p) => p.month !== null);
}
