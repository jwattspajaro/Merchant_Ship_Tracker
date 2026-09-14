import { config } from '../config.js';
import { withTransaction, query, closePool } from '../db.js';
import { classifyShipType } from '../lib/shipTypes.js';
import { navStatusLabel } from '../lib/navStatus.js';
import { flagFromMmsi } from '../lib/mid.js';
import { loadPortIndex } from '../core/portIndex.js';
import { processPosition } from '../core/callDetector.js';
import { ensurePartitions } from '../jobs/partitions.js';
import { AisStreamSource } from './aisstream.js';
import { isMainModule } from '../lib/isMain.js';

const PORT_INDEX_RELOAD_MS = 10 * 60_000;
const STATS_LOG_MS = 30_000;
const SEEN_PRUNE_MS = 60 * 60_000;

/** Elige la capa de ingesta. Anadir un proveedor = anadir un case y un archivo. */
export function createSource(cfg = config) {
  switch (cfg.ais.provider) {
    case 'aisstream':
      return new AisStreamSource(cfg.ais.aisstream);
    default:
      throw new Error(`Proveedor AIS desconocido: ${cfg.ais.provider}`);
  }
}

export class IngestPipeline {
  constructor({ source, portIndex, batchSize, flushMs, minIntervalS }) {
    this.source = source;
    this.portIndex = portIndex;
    this.batchSize = batchSize;
    this.flushMs = flushMs;
    this.minIntervalMs = minIntervalS * 1000;

    this.queue = [];
    /** mmsi -> 'Cargo' | 'Tanker'. Solo mercantes confirmados. */
    this.merchants = new Map();
    /** MMSI ya vistos y descartados por tipo: evita reconsultar la BD. */
    this.rejected = new Set();
    /** mmsi -> ms de la ultima posicion GUARDADA (para el intervalo minimo). */
    this.lastStored = new Map();

    this.flushing = false;
    this.timers = [];
    this.stats = { positions: 0, stored: 0, throttled: 0, dropped: 0, statics: 0, errors: 0 };
  }

  async start() {
    await this.#loadKnownMerchants();

    this.source.on('static', (s) => this.#onStatic(s).catch((e) => this.#onError('static', e)));
    this.source.on('position', (p) => this.#onPosition(p));
    this.source.on('open', () => console.log('[ingest] conectado a la fuente AIS'));
    this.source.on('close', (i) => console.warn('[ingest] conexion cerrada', i));
    this.source.on('reconnect_scheduled', (i) =>
      console.warn(`[ingest] reconectando en ${i.delayMs} ms (intento ${i.attempt})`),
    );
    this.source.on('error', (e) => this.#onError('source', e));

    this.timers.push(setInterval(() => this.flush().catch((e) => this.#onError('flush', e)), this.flushMs));
    this.timers.push(setInterval(() => this.#reloadPorts(), PORT_INDEX_RELOAD_MS));
    this.timers.push(setInterval(() => this.#pruneSeen(), SEEN_PRUNE_MS));
    this.timers.push(setInterval(() => this.#logStats(), STATS_LOG_MS));
    for (const t of this.timers) t.unref?.();

    this.source.start();
    console.log(
      `[ingest] en marcha: ${this.portIndex.size} puertos, ${this.merchants.size} mercantes conocidos`,
    );
  }

  async stop() {
    this.source.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.flush();
  }

  async #loadKnownMerchants() {
    const { rows } = await query(
      'SELECT mmsi, ship_type_label FROM vessels WHERE ship_type_label IS NOT NULL',
    );
    for (const r of rows) this.merchants.set(Number(r.mmsi), r.ship_type_label);
  }

  async #onStatic(s) {
    this.stats.statics += 1;
    const label = classifyShipType(s.shipTypeCode);

    // Filtro mercante (seccion 4.1): sin ShipStaticData con tipo 70-89 no se
    // guarda ni una posicion de ese MMSI.
    if (!label) {
      if (this.merchants.delete(s.mmsi)) {
        console.log(`[ingest] MMSI ${s.mmsi} reclasificado como no mercante (tipo ${s.shipTypeCode})`);
      }
      this.rejected.add(s.mmsi);
      return;
    }

    this.rejected.delete(s.mmsi);
    this.merchants.set(s.mmsi, label);

    await query(
      `INSERT INTO vessels (mmsi, imo, name, ship_type_code, ship_type_label, flag, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (mmsi) DO UPDATE SET
         imo             = COALESCE(EXCLUDED.imo, vessels.imo),
         name            = COALESCE(EXCLUDED.name, vessels.name),
         ship_type_code  = EXCLUDED.ship_type_code,
         ship_type_label = EXCLUDED.ship_type_label,
         flag            = COALESCE(EXCLUDED.flag, vessels.flag),
         last_seen_at    = GREATEST(vessels.last_seen_at, EXCLUDED.last_seen_at)`,
      [s.mmsi, s.imo, s.name, s.shipTypeCode, label, flagFromMmsi(s.mmsi)],
    );
  }

  #onPosition(p) {
    this.stats.positions += 1;

    if (!this.merchants.has(p.mmsi)) {
      this.stats.dropped += 1;
      return;
    }

    const ts = p.recordedAt.getTime();
    const last = this.lastStored.get(p.mmsi);
    if (this.minIntervalMs > 0 && last !== undefined && ts - last < this.minIntervalMs) {
      this.stats.throttled += 1;
      return;
    }
    this.lastStored.set(p.mmsi, ts);

    this.queue.push({
      mmsi: p.mmsi,
      recordedAt: p.recordedAt,
      lat: p.lat,
      lon: p.lon,
      sog: p.sog,
      cog: p.cog,
      navStatus: navStatusLabel(p.navStatusCode),
    });

    if (this.queue.length >= this.batchSize) {
      this.flush().catch((e) => this.#onError('flush', e));
    }
  }

  /**
   * Vuelca la cola en una transaccion. Las posiciones se procesan en orden de
   * llegada, que para un mismo MMSI es orden cronologico: la maquina de estados
   * de escalas depende de eso.
   */
  async flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];

    try {
      await this.#writeBatch(batch);
      this.stats.stored += batch.length;
    } catch (err) {
      // Causa tipica: falta la particion del mes. La creamos y reintentamos una vez.
      if (/no partition of relation/i.test(err.message)) {
        try {
          await ensurePartitions();
          await this.#writeBatch(batch);
          this.stats.stored += batch.length;
          return;
        } catch (retryErr) {
          this.#onError('flush_retry', retryErr);
          return;
        } finally {
          this.flushing = false;
        }
      }
      this.#onError('flush', err);
      console.error(`[ingest] lote de ${batch.length} posiciones descartado`);
    } finally {
      this.flushing = false;
    }
  }

  async #writeBatch(batch) {
    await withTransaction(async (client) => {
      for (const position of batch) {
        await processPosition(client, this.portIndex, position);
      }
    });
  }

  async #reloadPorts() {
    try {
      this.portIndex = await loadPortIndex();
    } catch (err) {
      this.#onError('port_reload', err);
    }
  }

  /** Suelta el estado de buques que llevan horas sin aparecer. */
  #pruneSeen() {
    const cutoff = Date.now() - SEEN_PRUNE_MS;
    for (const [mmsi, ts] of this.lastStored) {
      if (ts < cutoff) this.lastStored.delete(mmsi);
    }
    if (this.rejected.size > 200_000) this.rejected.clear();
  }

  #logStats() {
    const s = this.stats;
    console.log(
      `[ingest] posiciones=${s.positions} guardadas=${s.stored} limitadas=${s.throttled} ` +
        `descartadas_no_mercante=${s.dropped} estaticos=${s.statics} errores=${s.errors} ` +
        `cola=${this.queue.length} mercantes=${this.merchants.size}`,
    );
  }

  #onError(scope, err) {
    this.stats.errors += 1;
    console.error(`[ingest:${scope}]`, err.message);
  }
}

async function main() {
  await ensurePartitions();
  const portIndex = await loadPortIndex();
  if (portIndex.size === 0) {
    console.warn('[ingest] no hay puertos cargados: ejecuta "npm run seed" o no habra escalas');
  }

  const pipeline = new IngestPipeline({
    source: createSource(),
    portIndex,
    batchSize: config.ais.batchSize,
    flushMs: config.ais.flushMs,
    minIntervalS: config.ais.minIntervalS,
  });

  const shutdown = async (signal) => {
    console.log(`[ingest] ${signal}: cerrando, volcando cola pendiente...`);
    try {
      await pipeline.stop();
      await closePool();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await pipeline.start();
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[ingest] fallo al arrancar:', err);
    process.exit(1);
  });
}
