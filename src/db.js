import pg from 'pg';
import { config, requireDatabaseUrl } from './config.js';

// pg devuelve BIGINT (OID 20) como string para no perder precision. Los MMSI
// (9 digitos) e IMO (7 digitos) caben de sobra en un Number seguro, y los ids
// BIGSERIAL de este sistema no se acercan a 2^53. Los convertimos a numero para
// que la API devuelva JSON con numeros, no cadenas.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// NUMERIC (1700) -> Number. Solo aparece en agregados (AVG/EXTRACT EPOCH).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let pool = null;

export function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: requireDatabaseUrl(),
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // Cada conexion nueva trabaja en el esquema configurado.
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${quoteIdent(config.dbSchema)}, public`).catch(() => {});
  });
  pool.on('error', (err) => {
    console.error('[db] error en conexion inactiva:', err.message);
  });
  return pool;
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function query(text, params) {
  return getPool().query(text, params);
}

/** Ejecuta fn dentro de una transaccion, con commit/rollback automatico. */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
