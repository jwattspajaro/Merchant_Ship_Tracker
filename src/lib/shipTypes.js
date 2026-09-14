// Clasificacion de buques por el codigo ShipType del AIS (ITU-R M.1371).
// Solo nos interesan mercantes: carga (70-79) y tanque (80-89).
// Todo lo demas -- pesca, pasaje, remolcador, recreo, SAR, aeronaves (WIG),
// servicio publico -- se descarta y no genera ni una sola posicion guardada.

export const CARGO = 'Cargo';
export const TANKER = 'Tanker';

/**
 * @param {number|string|null|undefined} code codigo AIS crudo
 * @returns {'Cargo'|'Tanker'|null} null = no es mercante (o codigo invalido)
 */
export function classifyShipType(code) {
  const n = Number(code);
  if (!Number.isInteger(n)) return null;
  if (n >= 70 && n <= 79) return CARGO;
  if (n >= 80 && n <= 89) return TANKER;
  return null;
}

export function isMerchant(code) {
  return classifyShipType(code) !== null;
}
