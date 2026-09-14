import { query } from '../db.js';

/**
 * Declaraciones aduaneras: normalizacion y resolucion de puerto.
 *
 * Esta capa NO sabe de que formato viene el fichero. Recibe filas ya mapeadas a
 * un objeto con nombres propios, las normaliza y las guarda. Cambiar de origen
 * (otro fichero DIAN, la API de la otra plataforma, una replica de base) es
 * escribir otro adaptador, igual que con la ingesta AIS.
 */

/** Mayusculas y sin tildes, para que "Cartagena " y "CARTAGENA" sean lo mismo. */
export function normalizeAlias(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
  return s || null;
}

/** 'MARITIMO' / 'MARÍTIMO' / '1' / 'M' -> 'maritimo'. Lo que no encaje, null. */
export function normalizeTransportMode(value) {
  const s = normalizeAlias(value);
  if (!s) return null;
  if (/^(1|M|MAR|MARITIMO|MARITIMA|SEA|OCEAN)/.test(s)) return 'maritimo';
  if (/^(4|A|AER|AEREO|AEREA|AIR)/.test(s)) return 'aereo';
  if (/^(3|T|TER|TERRESTRE|CARRETERA|ROAD|TRUCK)/.test(s)) return 'terrestre';
  if (/^(F|FERR|RAIL|TREN)/.test(s)) return 'ferreo';
  return null;
}

/** Deja la subpartida en digitos. Las de 10 se recortan a 6 si se pide. */
export function normalizeHsCode(value, digits = null) {
  const s = String(value ?? '').replace(/\D/g, '');
  if (!s) return null;
  return digits ? s.slice(0, digits) : s;
}

/** Numero tolerante con separadores de miles y coma decimal. */
export function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // "1.234,56" -> 1234.56 ; "1,234.56" -> 1234.56
  let s = String(value).trim().replace(/\s/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Fecha tolerante: ISO, dd/mm/aaaa, aaaammdd. */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Carga las equivalencias de puerto de un origen en un Map en memoria.
 * Se consultan una vez por carga, no una vez por fila.
 */
export async function loadPortAliases(source) {
  const { rows } = await query(
    'SELECT alias, port_id FROM customs_port_aliases WHERE source IN ($1, $2)',
    [source, '*'],
  );
  return new Map(rows.map((r) => [r.alias, r.port_id]));
}

/**
 * Resuelve el puerto de una fila. Devuelve null si no se puede, y quien llama
 * DEBE contarlo e informarlo: descartar en silencio las filas sin puerto es la
 * forma mas rapida de que una correlacion salga limpia y sea mentira.
 */
export function resolvePort(aliases, ...candidates) {
  for (const candidate of candidates) {
    const key = normalizeAlias(candidate);
    if (key && aliases.has(key)) return aliases.get(key);
  }
  return null;
}

/**
 * Inserta un lote de declaraciones ya normalizadas. Idempotente cuando la fila
 * trae `source_row_id`.
 */
export async function insertDeclarations(client, rows) {
  let inserted = 0;
  for (const r of rows) {
    const res = await client.query(
      `INSERT INTO customs_declarations
         (source, source_row_id, flow, declared_on, arrived_on, importer_nit, importer_name,
          hs_code, origin_country, destination_country, customs_office_raw, port_raw, port_id,
          transport_mode, gross_weight_kg, net_weight_kg, fob_usd, cif_usd, transport_doc,
          free_zone, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (source, source_row_id) WHERE source_row_id IS NOT NULL DO NOTHING`,
      [
        r.source, r.source_row_id ?? null, r.flow, r.declared_on, r.arrived_on ?? null,
        r.importer_nit ?? null, r.importer_name ?? null, r.hs_code,
        r.origin_country ?? null, r.destination_country ?? null,
        r.customs_office_raw ?? null, r.port_raw ?? null, r.port_id ?? null,
        r.transport_mode ?? null, r.gross_weight_kg ?? null, r.net_weight_kg ?? null,
        r.fob_usd ?? null, r.cif_usd ?? null, r.transport_doc ?? null,
        r.free_zone ?? false, r.raw ? JSON.stringify(r.raw) : null,
      ],
    );
    inserted += res.rowCount;
  }
  return inserted;
}
