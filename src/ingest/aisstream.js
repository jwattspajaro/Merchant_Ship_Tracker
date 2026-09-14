import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Capa de ingesta para aisstream.io. ESTE ES EL UNICO ARCHIVO QUE CAMBIA al
 * cambiar de proveedor: normaliza lo que llegue a dos eventos y el resto del
 * sistema (esquema, deteccion, analitica, API) no sabe de donde salieron las
 * posiciones.
 *
 * Eventos emitidos:
 *   'static'   {mmsi, imo, name, callSign, shipTypeCode}
 *   'position' {mmsi, recordedAt: Date, lat, lon, sog, cog, navStatusCode}
 *   'open' | 'close' | 'error'
 *
 * Aviso sobre la fuente: aisstream.io es gratuito pero esta en beta, sin SLA
 * publicado y sin terminos comerciales claros. Sirve para desarrollar y probar;
 * no lo pongas debajo de un servicio que le cobras a alguien.
 */
export class AisStreamSource extends EventEmitter {
  constructor({ url, apiKey, boundingBoxes }) {
    super();
    if (!apiKey) throw new Error('Falta AISSTREAM_API_KEY');
    this.url = url;
    this.apiKey = apiKey;
    this.boundingBoxes = boundingBoxes;
    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  #connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      ws.send(
        JSON.stringify({
          APIKey: this.apiKey,
          BoundingBoxes: this.boundingBoxes,
          FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
        }),
      );
      this.emit('open');
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // trama corrupta: ignorar, llegaran mas
      }
      this.#handle(msg);
    });

    ws.on('error', (err) => this.emit('error', err));

    ws.on('close', (code, reason) => {
      this.emit('close', { code, reason: reason?.toString() });
      if (!this.stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    this.reconnectAttempt += 1;
    // Backoff exponencial con tope de 60 s y jitter, para no martillear la
    // fuente cuando esta caida.
    const base = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 6));
    const delay = base / 2 + Math.random() * (base / 2);
    this.emit('reconnect_scheduled', { attempt: this.reconnectAttempt, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #handle(msg) {
    const type = msg?.MessageType;
    const meta = msg?.MetaData ?? {};
    const mmsi = Number(meta.MMSI ?? meta.MMSI_String);
    if (!Number.isFinite(mmsi) || mmsi <= 0) return;

    if (type === 'ShipStaticData') {
      const s = msg.Message?.ShipStaticData;
      if (!s) return;
      this.emit('static', {
        mmsi,
        imo: toPositiveIntOrNull(s.ImoNumber),
        name: cleanString(s.Name ?? meta.ShipName),
        callSign: cleanString(s.CallSign),
        shipTypeCode: Number.isFinite(Number(s.Type)) ? Number(s.Type) : null,
      });
      return;
    }

    if (type === 'PositionReport') {
      const p = msg.Message?.PositionReport;
      if (!p) return;
      const lat = Number(p.Latitude);
      const lon = Number(p.Longitude);
      // 91/181 es el "no disponible" del AIS; fuera de rango es trama basura.
      if (!isValidLat(lat) || !isValidLon(lon)) return;

      this.emit('position', {
        mmsi,
        recordedAt: parseAisTime(meta.time_utc),
        lat,
        lon,
        // 102.3 nudos = velocidad no disponible; 360 = rumbo no disponible.
        sog: Number(p.Sog) >= 102.3 ? null : numOrNull(p.Sog),
        cog: Number(p.Cog) >= 360 ? null : numOrNull(p.Cog),
        navStatusCode: Number.isFinite(Number(p.NavigationalStatus))
          ? Number(p.NavigationalStatus)
          : null,
      });
    }
  }
}

const isValidLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const isValidLon = (v) => Number.isFinite(v) && v >= -180 && v <= 180;
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const toPositiveIntOrNull = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const cleanString = (v) =>
  typeof v === 'string' && v.trim() && !/^@+$/.test(v.trim()) ? v.trim().replace(/@+$/, '') : null;

/**
 * aisstream envia el tiempo en formato Go: "2024-05-01 12:34:56.789012345 +0000 UTC".
 * Lo pasamos a Date. Si no se puede interpretar, usamos la hora de recepcion --
 * degradar a "ahora" es preferible a descartar la posicion, pero nunca se
 * inventa una hora pasada.
 */
export function parseAisTime(value) {
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
    if (m) {
      const millis = (m[3] ?? '').slice(0, 3).padEnd(3, '0');
      const d = new Date(`${m[1]}T${m[2]}.${millis}Z`);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return new Date();
}
