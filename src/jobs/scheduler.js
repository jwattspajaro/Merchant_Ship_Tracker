import { config } from '../config.js';
import { closePool } from '../db.js';
import { ensurePartitions } from './partitions.js';
import { runRetention } from './retention.js';

/**
 * Tarea diaria de mantenimiento (seccion 7). Corre a MAINTENANCE_HOUR hora
 * local, de madrugada por defecto.
 *
 * Sin dependencia de cron: el proceso calcula el tiempo que falta hasta la
 * proxima ejecucion y se reprograma. Si prefieres el cron del sistema o el
 * Programador de tareas de Windows, usa:
 *     npm run job:partitions
 *     npm run job:retention
 */
export async function runMaintenance() {
  const started = Date.now();
  const created = await ensurePartitions();
  if (created.length) console.log(`[jobs] particiones creadas: ${created.join(', ')}`);
  else console.log('[jobs] particiones: nada que crear');

  const retention = await runRetention();
  console.log(
    `[jobs] mantenimiento terminado en ${Date.now() - started} ms; ` +
      `particiones archivadas: ${retention.archived.length}`,
  );
  return { created, retention };
}

export function msUntilNextRun(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleLoop() {
  const hour = config.retention.maintenanceHour;
  const delay = msUntilNextRun(hour);
  console.log(
    `[jobs] proxima ejecucion en ${Math.round(delay / 60_000)} min (a las ${hour}:00 hora local)`,
  );
  setTimeout(async () => {
    try {
      await runMaintenance();
    } catch (err) {
      console.error('[jobs] fallo el mantenimiento:', err.message);
    }
    scheduleLoop();
  }, delay).unref?.();
}

async function main() {
  const onceArg = process.argv.find((a) => a.startsWith('--once'));

  if (onceArg) {
    const which = onceArg.split('=')[1] ?? 'all';
    try {
      if (which === 'partitions') {
        const created = await ensurePartitions();
        console.log(created.length ? `creadas: ${created.join(', ')}` : 'nada que crear');
      } else if (which === 'retention') {
        console.log(JSON.stringify(await runRetention(), null, 2));
      } else {
        await runMaintenance();
      }
    } finally {
      await closePool();
    }
    return;
  }

  // Al arrancar nos aseguramos de que existen las particiones: si el proceso
  // llevaba parado desde el mes pasado, la ingesta fallaria al primer INSERT.
  await ensurePartitions();
  scheduleLoop();
  console.log('[jobs] planificador en marcha (Ctrl+C para salir)');
  setInterval(() => {}, 1 << 30); // mantiene vivo el proceso
}

main().catch((err) => {
  console.error('[jobs] fallo al arrancar:', err);
  process.exit(1);
});
