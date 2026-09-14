import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { query, quoteIdent, closePool } from '../src/db.js';
import { ensurePartitions } from '../src/jobs/partitions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function migrate() {
  if (config.dbSchema !== 'public') {
    await query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(config.dbSchema)}`);
  }

  const sql = await readFile(join(root, 'db', 'schema.sql'), 'utf8');
  await query(sql);
  console.log(`[migrate] esquema aplicado en "${config.dbSchema}"`);

  const created = await ensurePartitions();
  console.log(
    created.length
      ? `[migrate] particiones creadas: ${created.join(', ')}`
      : '[migrate] particiones: ya estaban',
  );
}

if (process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(() => closePool())
    .catch(async (err) => {
      console.error('[migrate] fallo:', err.message);
      await closePool();
      process.exit(1);
    });
}
