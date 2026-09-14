import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { query, closePool } from '../db.js';
import {
  listVessels,
  getVessel,
  getVesselDwell,
  getCurrentLeg,
  getPort,
  getPortDwellStats,
} from '../core/analytics.js';
import { estimateRoute } from '../core/routes.js';
import { describeCargoOperations, CARGO_OPERATIONS_UNAVAILABLE } from '../core/cargoOperations.js';
import { isMainModule } from '../lib/isMain.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Visor de mapa. Se sirve desde el propio proceso a proposito: una pagina
  // alojada en otro origen no puede consultar esta API en localhost.
  app.use(express.static(publicDir));

  app.get('/health', async (_req, res, next) => {
    try {
      const { rows } = await query('SELECT now() AS db_time');
      res.json({ status: 'ok', db_time: rows[0].db_time });
    } catch (err) {
      next(err);
    }
  });

  // --- Buques -------------------------------------------------------------

  /** Ultimos buques mercantes vistos + su posicion mas reciente. */
  app.get('/vessels', async (req, res, next) => {
    try {
      const limit = clampInt(req.query.limit, 1, 1000, 100);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      const shipType = req.query.type ? String(req.query.type) : null;
      if (shipType && !['Cargo', 'Tanker'].includes(shipType)) {
        return res.status(400).json({ error: "type debe ser 'Cargo' o 'Tanker'" });
      }
      res.json({ limit, offset, vessels: await listVessels({ limit, offset, shipType }) });
    } catch (err) {
      next(err);
    }
  });

  /** Escala actual o mas reciente de un buque. */
  app.get('/vessels/:mmsi/dwell', async (req, res, next) => {
    try {
      const mmsi = parseId(req.params.mmsi);
      if (mmsi === null) return res.status(400).json({ error: 'mmsi invalido' });

      const vessel = await getVessel(mmsi);
      if (!vessel) return res.status(404).json({ error: 'buque desconocido', mmsi });

      const call = await getVesselDwell(mmsi);
      if (!call) {
        return res.json({
          mmsi,
          vessel: vesselSummary(vessel),
          port_call: null,
          message: 'Este buque no tiene ninguna escala registrada todavia.',
        });
      }

      res.json({
        mmsi,
        vessel: vesselSummary(vessel),
        port_call: {
          id: call.id,
          port: { id: call.port_id, unlocode: call.unlocode, name: call.port_name, country: call.port_country },
          call_type: call.call_type,
          arrived_at: call.arrived_at,
          departed_at: call.departed_at,
          dwell_seconds: call.dwell_seconds,
          dwell_hours: round(call.dwell_seconds / 3600, 2),
          is_open: call.departed_at === null,
        },
        // Seccion 4.3: hasta donde llega el AIS y hasta donde no.
        cargo_operations: describeCargoOperations(call),
      });
    } catch (err) {
      next(err);
    }
  });

  /** Tramo en curso (todavia sin puerto de destino). */
  app.get('/vessels/:mmsi/current-leg', async (req, res, next) => {
    try {
      const mmsi = parseId(req.params.mmsi);
      if (mmsi === null) return res.status(400).json({ error: 'mmsi invalido' });

      const vessel = await getVessel(mmsi);
      if (!vessel) return res.status(404).json({ error: 'buque desconocido', mmsi });

      const leg = await getCurrentLeg(mmsi);
      if (!leg) {
        return res.json({
          mmsi,
          vessel: vesselSummary(vessel),
          current_leg: null,
          message: 'El buque no esta en transito entre puertos ahora mismo (o esta en puerto).',
        });
      }

      res.json({
        mmsi,
        vessel: vesselSummary(vessel),
        current_leg: {
          id: leg.id,
          origin_port: leg.origin_port_id
            ? {
                id: leg.origin_port_id,
                unlocode: leg.origin_unlocode,
                name: leg.origin_name,
                lat: leg.origin_lat,
                lon: leg.origin_lon,
              }
            : null,
          departed_at: leg.departed_at,
          elapsed_seconds: leg.elapsed_seconds,
          elapsed_hours: round(leg.elapsed_seconds / 3600, 2),
          destination_port: null,
          // El AIS lleva un campo Destination escrito a mano por la tripulacion;
          // no se usa aqui. El destino se conoce cuando el buque llega.
          destination_note:
            'El destino se determina por observacion, al entrar el buque en el radio de un puerto. No se predice.',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Seccion 4.3: este dato NO se estima a partir del AIS. El endpoint existe
   * para decirlo de forma explicita en lugar de devolver un numero inventado.
   */
  app.get('/vessels/:mmsi/cargo-operations', async (req, res, next) => {
    try {
      const mmsi = parseId(req.params.mmsi);
      if (mmsi === null) return res.status(400).json({ error: 'mmsi invalido' });

      const vessel = await getVessel(mmsi);
      if (!vessel) return res.status(404).json({ error: 'buque desconocido', mmsi });

      const call = await getVesselDwell(mmsi);
      res.status(501).json({
        mmsi,
        vessel: vesselSummary(vessel),
        cargo_operations: describeCargoOperations(call),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Puertos ------------------------------------------------------------

  app.get('/ports', async (req, res, next) => {
    try {
      const q = req.query.q ? `%${String(req.query.q)}%` : null;
      const { rows } = await query(
        `SELECT id, unlocode, name, country, lat, lon, approach_radius_m
           FROM ports
          WHERE $1::text IS NULL OR name ILIKE $1 OR unlocode ILIKE $1
          ORDER BY name
          LIMIT 500`,
        [q],
      );
      res.json({ ports: rows });
    } catch (err) {
      next(err);
    }
  });

  /** Permanencia promedio de un puerto, separada por tipo de escala. */
  app.get('/ports/:id/dwell-stats', async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ error: 'id de puerto invalido' });

      const port = await getPort(id);
      if (!port) return res.status(404).json({ error: 'puerto desconocido', id });

      const stats = await getPortDwellStats(id);
      const byType = Object.fromEntries(
        stats.map((s) => [
          s.call_type,
          {
            calls: s.calls,
            avg_dwell_seconds: round(s.avg_dwell_seconds, 1),
            avg_dwell_hours: round(s.avg_dwell_seconds / 3600, 2),
            median_dwell_seconds: round(s.median_dwell_seconds, 1),
            min_dwell_seconds: round(s.min_dwell_seconds, 1),
            max_dwell_seconds: round(s.max_dwell_seconds, 1),
          },
        ]),
      );

      res.json({
        port: {
          id: port.id,
          unlocode: port.unlocode,
          name: port.name,
          country: port.country,
          lat: port.lat,
          lon: port.lon,
          approach_radius_m: port.approach_radius_m,
        },
        dwell_stats: {
          berth: byType.berth ?? emptyStats(),
          anchorage: byType.anchorage ?? emptyStats(),
        },
        basis:
          'Solo escalas cerradas (departed_at IS NOT NULL). Las escalas abiertas no tienen duracion final.',
        interpretation: {
          berth: 'Atracado: ventana probable de operacion de carga. Ver cargo_operations.',
          anchorage: 'Fondeado: espera, no trabajo.',
          cargo_operations: CARGO_OPERATIONS_UNAVAILABLE.message,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Rutas --------------------------------------------------------------

  /** Ruta estimada entre dos puertos + estadisticas de transito. */
  app.get('/routes/:originPortId/:destinationPortId', async (req, res, next) => {
    try {
      const origin = parseId(req.params.originPortId);
      const destination = parseId(req.params.destinationPortId);
      if (origin === null || destination === null) {
        return res.status(400).json({ error: 'id de puerto invalido' });
      }

      const route = await estimateRoute(origin, destination);
      if (!route) return res.status(404).json({ error: 'puerto de origen o destino desconocido' });
      res.json(route);
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'ruta no encontrada', path: req.path }));

  app.use((err, _req, res, _next) => {
    console.error('[api]', err);
    res.status(500).json({ error: 'error interno' });
  });

  return app;
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const f = 10 ** decimals;
  return Math.round(Number(value) * f) / f;
}

function vesselSummary(v) {
  return {
    mmsi: v.mmsi,
    imo: v.imo,
    name: v.name,
    ship_type_code: v.ship_type_code,
    ship_type_label: v.ship_type_label,
    flag: v.flag,
    last_seen_at: v.last_seen_at,
  };
}

function emptyStats() {
  return {
    calls: 0,
    avg_dwell_seconds: null,
    avg_dwell_hours: null,
    median_dwell_seconds: null,
    min_dwell_seconds: null,
    max_dwell_seconds: null,
  };
}

if (isMainModule(import.meta.url)) {
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] escuchando en http://localhost:${config.port}`);
  });

  server.on('error', (err) => {
    // Lo mas habitual al arrancar: el puerto lo tiene otro proceso. Un volcado
    // de pila no ayuda a nadie; decir que pasa y como salir de ello, si.
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[api] el puerto ${config.port} ya esta ocupado por otro proceso.\n` +
          `      Libera el puerto o arranca en otro:  PORT=3010 npm run api`,
      );
      process.exit(1);
    }
    console.error('[api] no se pudo abrir el servidor:', err.message);
    process.exit(1);
  });
  const shutdown = () => server.close(() => closePool().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
