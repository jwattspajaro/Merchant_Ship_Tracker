// Estado de navegacion AIS (ITU-R M.1371, campo Navigational status).
// Se guarda como texto en vessel_positions.nav_status; el codigo desconocido se
// conserva tal cual ("unknown (23)") en vez de inventarle una etiqueta.

const NAV_STATUS = {
  0: 'under way using engine',
  1: 'at anchor',
  2: 'not under command',
  3: 'restricted manoeuverability',
  4: 'constrained by her draught',
  5: 'moored',
  6: 'aground',
  7: 'engaged in fishing',
  8: 'under way sailing',
  9: 'reserved (HSC)',
  10: 'reserved (WIG)',
  11: 'towing astern',
  12: 'pushing ahead or towing alongside',
  13: 'reserved',
  14: 'AIS-SART / MOB / EPIRB',
  15: 'undefined',
};

export function navStatusLabel(code) {
  const n = Number(code);
  if (!Number.isInteger(n)) return null;
  return NAV_STATUS[n] ?? `unknown (${n})`;
}
