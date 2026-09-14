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
 * Lee el cambio de calado de una escala. Es lo mas cerca que el AIS deja llegar
 * a "se movio carga", y aun asi es una inferencia: el calado lo teclea la
 * tripulacion, viene redondeado a 0,1 m, y para pasar de metros a toneladas
 * hace falta la tabla hidrostatica del buque, que el AIS no transmite.
 *
 * Hay direccion y magnitud relativa. No hay tonelaje.
 */
export function describeDraughtChange(portCall) {
  const from = portCall?.draught_on_arrival ?? null;
  const to = portCall?.draught_on_departure ?? null;
  if (from === null || to === null) {
    return {
      available: false,
      reason: portCall?.departed_at ? 'draught_not_reported' : 'call_still_open',
      message:
        'Sin calado declarado en la llegada y en la salida no se puede inferir nada sobre la carga.',
    };
  }

  const delta = Number((to - from).toFixed(2));
  const direction = delta > 0.05 ? 'loaded' : delta < -0.05 ? 'discharged' : 'no_significant_change';
  return {
    available: true,
    draught_on_arrival_m: from,
    draught_on_departure_m: to,
    draught_delta_m: delta,
    direction,
    interpretation: {
      loaded: 'El buque salio mas hundido: carga neta embarcada.',
      discharged: 'El buque salio mas ligero: descarga neta.',
      no_significant_change:
        'El calado apenas cambio (menos de 10 cm). O no se movio carga, o entro tanta como salio, o nadie actualizo el dato.',
    }[direction],
    is_inference: true,
    caveats: [
      'El calado lo declara la tripulacion a mano: se queda desactualizado o mal puesto con frecuencia.',
      'Viene redondeado a 0,1 m, asi que movimientos pequenos no se distinguen del ruido.',
      'De metros a toneladas hace falta la tabla hidrostatica del buque (TPC), que el AIS no da: hay direccion y magnitud relativa, no tonelaje.',
      'Tambien cambia con el consumo de combustible, el lastre y la densidad del agua, no solo con la carga.',
    ],
  };
}

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
    // Lo unico que el AIS deja inferir sobre carga, y etiquetado como tal.
    draught_change: describeDraughtChange(portCall),
    note: isBerth
      ? undefined
      : "La escala es de tipo 'anchorage': el buque esta fondeado, probablemente esperando turno, no trabajando.",
  };
}
