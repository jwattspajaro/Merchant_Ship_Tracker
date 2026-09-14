/**
 * Carga declaraciones aduaneras desde un fichero delimitado.
 *
 *   node scripts/import-customs.js --file datos.csv --source dian_2019 --profile ejemplo
 *
 * El cargador no sabe nada del formato: eso vive en db/customs-profiles/<perfil>.json.
 * Cambiar de origen es escribir otro perfil, igual que cambiar de proveedor AIS
 * es escribir otro archivo en src/ingest/.
 *
 * Idempotente cuando el perfil mapea `source_row_id`: recargar el mismo fichero
 * no duplica nada.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withTransaction, closePool } from '../src/db.js';
import { isMainModule } from '../src/lib/isMain.js';
import {
  normalizeAlias,
  normalizeTransportMode,
  normalizeHsCode,
  parseNumber,
  parseDate,
  loadPortAliases,
  resolvePort,
  insertDeclarations,
} from '../src/core/customs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BATCH = 500;

function arg(name, fallback = null) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (found) return found.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

/**
 * Lector de delimitados con comillas. No se usa una libreria a proposito: es
 * una dependencia menos y el formato que hay que soportar cabe aqui.
 */
export function parseDelimited(text, delimiter = ';') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += c;
  }
  if (field !== '' || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v !== ''));
}

export async function importCustoms({ file, source, profileName }) {
  const profile = JSON.parse(
    readFileSync(join(root, 'db', 'customs-profiles', `${profileName}.json`), 'utf8'),
  );
  const text = readFileSync(file, profile.encoding === 'latin1' ? 'latin1' : 'utf8');
  const rows = parseDelimited(text, profile.delimiter || ';');
  if (rows.length < 2) throw new Error('El fichero no tiene ni cabecera ni datos.');

  const header = rows[0].map((h) => h.trim());
  const indexOf = (columnName) => (columnName ? header.indexOf(columnName) : -1);
  const idx = {};
  for (const [ours, theirs] of Object.entries(profile.columns)) idx[ours] = indexOf(theirs);

  // Lo que el perfil pide y el fichero no tiene: se dice antes de empezar, no
  // se descubre a mitad con todas las filas ya a medio cargar.
  const missing = Object.entries(profile.columns)
    .filter(([ours, theirs]) => theirs && idx[ours] === -1)
    .map(([ours, theirs]) => `${ours} -> "${theirs}"`);
  if (missing.length) {
    throw new Error(
      `El perfil "${profileName}" pide columnas que el fichero no tiene:\n  ${missing.join('\n  ')}\n` +
        `Cabecera encontrada: ${header.join(', ')}`,
    );
  }

  const aliases = await loadPortAliases(source);
  const freeZoneValues = new Set((profile.free_zone_values || []).map(normalizeAlias));
  const countryMap = profile.country_map || {};

  const stats = {
    leidas: 0, insertadas: 0, duplicadas: 0,
    sin_puerto: 0, sin_fecha: 0, sin_subpartida: 0, sin_modo_transporte: 0, zona_franca: 0,
  };
  const get = (row, field) => (idx[field] >= 0 ? row[idx[field]] : null);

  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const inserted = await withTransaction((client) => insertDeclarations(client, batch));
    stats.insertadas += inserted;
    stats.duplicadas += batch.length - inserted;
    batch = [];
  };

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    stats.leidas += 1;

    const declaredOn = parseDate(get(row, 'declared_on'));
    const hsCode = normalizeHsCode(get(row, 'hs_code'), profile.hs_digits);
    // Sin fecha o sin subpartida la fila no sirve para ninguna serie.
    if (!declaredOn) { stats.sin_fecha += 1; continue; }
    if (!hsCode) { stats.sin_subpartida += 1; continue; }

    const portId = resolvePort(aliases, get(row, 'port_raw'), get(row, 'customs_office_raw'));
    if (portId === null) stats.sin_puerto += 1;

    const mode = normalizeTransportMode(get(row, 'transport_mode'));
    if (!mode) stats.sin_modo_transporte += 1;

    const freeZone = freeZoneValues.has(normalizeAlias(get(row, 'free_zone')));
    if (freeZone) stats.zona_franca += 1;

    const originRaw = normalizeAlias(get(row, 'origin_country'));

    batch.push({
      source,
      source_row_id: get(row, 'source_row_id') || null,
      flow: profile.flow || 'import',
      declared_on: declaredOn,
      arrived_on: parseDate(get(row, 'arrived_on')),
      importer_nit: get(row, 'importer_nit') || null,
      importer_name: get(row, 'importer_name') || null,
      hs_code: hsCode,
      origin_country: countryMap[originRaw] ?? originRaw,
      destination_country: normalizeAlias(get(row, 'destination_country')),
      customs_office_raw: get(row, 'customs_office_raw') || null,
      port_raw: get(row, 'port_raw') || null,
      port_id: portId,
      transport_mode: mode,
      gross_weight_kg: parseNumber(get(row, 'gross_weight_kg')),
      net_weight_kg: parseNumber(get(row, 'net_weight_kg')),
      fob_usd: parseNumber(get(row, 'fob_usd')),
      cif_usd: parseNumber(get(row, 'cif_usd')),
      transport_doc: get(row, 'transport_doc') || null,
      free_zone: freeZone,
      raw: Object.fromEntries(header.map((h, i) => [h, row[i] ?? null])),
    });

    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return stats;
}

async function main() {
  const file = arg('file');
  const source = arg('source');
  const profileName = arg('profile', 'ejemplo');
  if (!file || !source) {
    console.error('Uso: node scripts/import-customs.js --file <ruta> --source <nombre> --profile <perfil>');
    process.exit(1);
  }

  const stats = await importCustoms({ file, source, profileName });
  console.log('[aduanas] carga terminada:');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(22)} ${v}`);

  // Los descartes se ven. Una carga que "sale limpia" escondiendo lo que no
  // pudo mapear produce correlaciones bonitas y falsas.
  if (stats.sin_puerto) {
    console.warn(
      `\n[aduanas] ${stats.sin_puerto} filas sin puerto resoluble: se guardaron con port_id NULL\n` +
        '          y NO entran en ninguna serie por puerto. Anade equivalencias en customs_port_aliases.',
    );
  }
  if (stats.zona_franca) {
    console.warn(
      `[aduanas] ${stats.zona_franca} filas de zona franca: se guardan, pero quedan fuera de la\n` +
        '          correlacion. La mercancia no sale del pais y ningun buque la mueve.',
    );
  }
}

if (isMainModule(import.meta.url)) {
  main()
    .then(() => closePool())
    .catch(async (err) => {
      console.error('[aduanas] fallo:', err.message);
      await closePool();
      process.exit(1);
    });
}
