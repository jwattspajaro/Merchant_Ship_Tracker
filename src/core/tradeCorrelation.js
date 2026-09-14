import { query } from '../db.js';
import { getPortTraffic } from './analytics.js';

/**
 * Correlacion entre lo declarado en aduana y lo observado por AIS.
 *
 * Se correlacionan SERIES, no envios. Nunca dice "este buque trajo esta carga":
 * dice si el peso declarado en un puerto y el trafico observado en ese mismo
 * puerto se mueven juntos en el tiempo.
 *
 * Periodos minimos para que el coeficiente signifique algo. Por debajo se
 * devuelve igualmente, pero marcado como no fiable: con cuatro meses no hay
 * correlacion, hay ruido.
 */
export const MIN_RELIABLE_PERIODS = 12;

/** Coeficiente de Pearson. Mide relacion lineal. Sensible a valores extremos. */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null; // una de las series es constante
  return Number((num / Math.sqrt(dx * dy)).toFixed(4));
}

/**
 * Coeficiente de Spearman: Pearson sobre los rangos.
 * Mas robusto que Pearson cuando hay un mes atipico que se lleva la serie, que
 * en comercio pasa constantemente.
 */
export function spearman(xs, ys) {
  if (xs.length < 2) return null;
  return pearson(toRanks(xs), toRanks(ys));
}

function toRanks(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[i].v) j += 1;
    // Empates: rango medio, si no se inflaria la correlacion.
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[sorted[k].i] = rank;
    i = j + 1;
  }
  return ranks;
}

/** Serie aduanera agregada por periodo para un puerto. */
export async function getCustomsSeries(portId, { from, to, bucket = 'month', hsCode = null, flow = 'import' } = {}) {
  const allowed = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };
  const unit = allowed[bucket];
  if (!unit) throw new Error(`bucket debe ser uno de: ${Object.keys(allowed).join(', ')}`);

  const { rows } = await query(
    `SELECT date_trunc('${unit}', declared_on)::date AS period,
            COUNT(*)::int              AS declarations,
            SUM(gross_weight_kg)       AS gross_weight_kg,
            SUM(COALESCE(cif_usd, fob_usd)) AS value_usd
       FROM customs_declarations
      WHERE port_id = $1
        AND declared_on >= $2 AND declared_on < $3
        AND flow = $4
        AND transport_mode = 'maritimo'
        AND free_zone = FALSE
        AND ($5::text IS NULL OR hs_code LIKE $5 || '%')
      GROUP BY period
      ORDER BY period`,
    [portId, from, to, flow, hsCode],
  );
  return rows;
}

/** Cuenta lo que queda fuera de la serie y por que. Sin esto, la correlacion miente. */
export async function getExclusions(portId, { from, to, flow = 'import', hsCode = null } = {}) {
  const { rows } = await query(
    `SELECT
        COUNT(*) FILTER (WHERE free_zone)::int                          AS zona_franca,
        COUNT(*) FILTER (WHERE transport_mode IS DISTINCT FROM 'maritimo')::int AS no_maritimo,
        COUNT(*)::int                                                   AS total
       FROM customs_declarations
      WHERE port_id = $1 AND declared_on >= $2 AND declared_on < $3 AND flow = $4
        AND ($5::text IS NULL OR hs_code LIKE $5 || '%')`,
    [portId, from, to, flow, hsCode],
  );
  const { rows: huerfanas } = await query(
    `SELECT COUNT(*)::int AS sin_puerto FROM customs_declarations
      WHERE port_id IS NULL AND declared_on >= $1 AND declared_on < $2 AND flow = $3`,
    [from, to, flow],
  );
  return { ...rows[0], ...huerfanas[0] };
}

/**
 * Cruza ambas series y devuelve los coeficientes con su n.
 *
 * Solo se correlacionan los periodos presentes en LAS DOS series. Rellenar con
 * ceros los meses que faltan en una de ellas inventaria correlacion donde solo
 * hay ausencia de datos.
 */
export async function getTradeCorrelation(portId, options = {}) {
  const { from, to, bucket = 'month', hsCode = null, flow = 'import' } = options;

  const [customs, traffic, exclusions] = await Promise.all([
    getCustomsSeries(portId, { from, to, bucket, hsCode, flow }),
    getPortTraffic(portId, { from, to, bucket }),
    getExclusions(portId, { from, to, flow, hsCode }),
  ]);

  // El trafico viene separado por call_type; para correlacionar interesa el
  // atraque, que es donde se trabaja la carga. El fondeo es espera.
  const berthByPeriod = new Map();
  for (const t of traffic) {
    if (t.call_type !== 'berth') continue;
    const key = new Date(t.period).toISOString().slice(0, 10);
    berthByPeriod.set(key, t);
  }

  const paired = [];
  for (const c of customs) {
    const key = new Date(c.period).toISOString().slice(0, 10);
    const t = berthByPeriod.get(key);
    if (!t) continue;
    paired.push({
      period: key,
      declared_weight_kg: Number(c.gross_weight_kg ?? 0),
      declared_value_usd: Number(c.value_usd ?? 0),
      declarations: c.declarations,
      observed_calls: t.calls,
      observed_vessels: t.vessels,
      observed_avg_dwell_seconds: t.avg_dwell_seconds,
    });
  }

  const weights = paired.map((p) => p.declared_weight_kg);
  const calls = paired.map((p) => p.observed_calls);
  const n = paired.length;

  return {
    window: { from, to, bucket, hs_code: hsCode, flow },
    periods: n,
    reliable: n >= MIN_RELIABLE_PERIODS,
    correlation: {
      weight_vs_calls_pearson: pearson(weights, calls),
      weight_vs_calls_spearman: spearman(weights, calls),
    },
    series: paired,
    excluded: exclusions,
    notes: [
      n >= MIN_RELIABLE_PERIODS
        ? null
        : `Solo ${n} periodos emparejados. Hacen falta al menos ${MIN_RELIABLE_PERIODS} para que el coeficiente signifique algo; con menos es ruido.`,
      'Se correlacionan series, no envios. Esto no dice que buque trajo que carga.',
      'Lo observado mide presencia y tiempo de muelle, no tonelaje: el AIS no da toneladas.',
      exclusions.zona_franca > 0
        ? `${exclusions.zona_franca} declaraciones de zona franca fuera de la serie: la mercancia no sale del pais y ningun buque la mueve.`
        : null,
      exclusions.no_maritimo > 0
        ? `${exclusions.no_maritimo} declaraciones no maritimas fuera de la serie.`
        : null,
      exclusions.sin_puerto > 0
        ? `${exclusions.sin_puerto} declaraciones sin puerto resoluble en la ventana. Revisa customs_port_aliases.`
        : null,
    ].filter(Boolean),
  };
}
