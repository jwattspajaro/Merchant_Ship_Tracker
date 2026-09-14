import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, closePool } from '../src/db.js';
import { isMainModule } from '../src/lib/isMain.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function seedPorts() {
  const sql = await readFile(join(root, 'db', 'seed_ports.sql'), 'utf8');
  await query(sql);
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM ports');
  console.log(`[seed] ${rows[0].n} puertos en la tabla ports`);
  return rows[0].n;
}

if (isMainModule(import.meta.url)) {
  seedPorts()
    .then(() => closePool())
    .catch(async (err) => {
      console.error('[seed] fallo:', err.message);
      await closePool();
      process.exit(1);
    });
}
