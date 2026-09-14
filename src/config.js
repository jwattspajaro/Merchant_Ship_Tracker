import 'dotenv/config';

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function json(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Valor no es JSON valido: ${value}`);
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  dbSchema: process.env.DB_SCHEMA || 'public',

  port: int(process.env.PORT, 3000),

  ais: {
    provider: process.env.AIS_PROVIDER || 'aisstream',
    aisstream: {
      url: process.env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream',
      apiKey: process.env.AISSTREAM_API_KEY || '',
      boundingBoxes: json(process.env.AIS_BOUNDING_BOXES, [[[-90, -180], [90, 180]]]),
    },
    batchSize: int(process.env.INGEST_BATCH_SIZE, 200),
    flushMs: int(process.env.INGEST_FLUSH_MS, 5000),
    minIntervalS: int(process.env.INGEST_MIN_INTERVAL_S, 60),
  },

  retention: {
    rawRetentionDays: int(process.env.RAW_RETENTION_DAYS, 90),
    maintenanceHour: int(process.env.MAINTENANCE_HOUR, 3),
  },
};

export function requireDatabaseUrl() {
  if (!config.databaseUrl) {
    throw new Error('Falta DATABASE_URL (copia .env.example a .env y rellenalo).');
  }
  return config.databaseUrl;
}
