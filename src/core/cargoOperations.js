/**
 * Seccion 4.3 -- limite real de lo que da el AIS.
 *
 * El AIS transmite posicion, rumbo, velocidad y estado de navegacion. NO dice
 * si un buque esta cargando, descargando, ambas cosas, ni cuanta carga se movio.
 * Por eso aqui no hay ni marcas de tiempo de "inicio/fin de descarga" ni
 * cantidades: no se derivan de este dato.
 *
 * Lo que SI se construye con AIS y es lo que este sistema entrega:
 * la escala de tipo 'berth' es la ventana PROBABLE de operacion de carga
 * (arrived_at -> departed_at), y su promedio historico por puerto es la mejor
 * aproximacion disponible al "tiempo tipico de desembarco" sin datos del
 * operador portuario.
 *
 * La unica via a un dato real de carga es integrar el TOS/EDI del operador de
 * terminal, o un proveedor comercial que venda hitos de contenedor
 * (Gate-In / Loaded / Discharged / Departed). Eso no esta en este alcance, y la
 * API lo dice de forma explicita en vez de estimarlo como si fuera medido.
 */

export const CARGO_OPERATIONS_UNAVAILABLE = Object.freeze({
  available: false,
  reason: 'not_available_in_this_phase',
  message:
    'El detalle de operacion de carga (inicio/fin de descarga, tipo de operacion, cantidad movida) no esta disponible en esta fase. El AIS no transmite ese dato.',
  what_ais_gives_instead:
    "La escala de tipo 'berth' delimita la ventana probable de operacion de carga (arrived_at -> departed_at). Usa /ports/:id/dwell-stats para el promedio historico por puerto.",
  how_to_get_the_real_data: [
    'Integrar el TOS/EDI del operador de terminal.',
    'Contratar un proveedor comercial de hitos de contenedor (Gate-In / Loaded / Discharged / Departed).',
  ],
});

/**
 * Anota una escala con lo que se puede y no se puede afirmar sobre la operacion
 * de carga. Una escala 'berth' abierta es una ventana probable EN CURSO; una
 * 'anchorage' es espera, no trabajo.
 */
export function describeCargoOperations(portCall) {
  if (!portCall) return { ...CARGO_OPERATIONS_UNAVAILABLE, likely_working_window: null };

  const isBerth = portCall.call_type === 'berth';
  return {
    ...CARGO_OPERATIONS_UNAVAILABLE,
    likely_working_window: isBerth
      ? {
          basis: 'berth_port_call',
          started_at: portCall.arrived_at,
          ended_at: portCall.departed_at, // null = sigue atracado
          seconds: portCall.dwell_seconds,
          is_open: portCall.departed_at === null,
          caveat:
            'Ventana inferida de la posicion AIS: el buque esta en el muelle. No es confirmacion de que se este moviendo carga.',
        }
      : null,
    note: isBerth
      ? undefined
      : "La escala es de tipo 'anchorage': el buque esta fondeado, probablemente esperando turno, no trabajando.",
  };
}
