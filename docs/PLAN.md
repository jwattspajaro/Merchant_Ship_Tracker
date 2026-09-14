# Plan de trabajo: aduanas + huecos de cobertura

Documento vivo. Marca las casillas según avances. Si retomas esto en otra
sesión o lo coge otra persona, **empieza por "Cómo retomar"** al final.

Última actualización: 2026-09-14. **Fase B terminada.** Fase A bloqueada a la espera de la cabecera real del fichero de declaraciones.

---

## Objetivo

Que el sistema deje de ser un mapa de barcos y sirva para análisis de comercio
internacional. Dos frentes independientes:

- **A. Declaraciones aduaneras como segunda fuente**, y correlación contra el
  tráfico observado, sin salir de la misma base de datos.
- **B. Huecos de cobertura AIS**: cuando un buque desaparece, reconstruir el
  trayecto que faltó sobre la ruta marítima, con su velocidad media implícita y
  su duración en días — **marcado siempre como estimado, nunca como observado**.

Se pueden hacer en cualquier orden. B es más pequeño y es el que mejora la
calidad de los datos que A va a correlacionar, así que **empezar por B** tiene
sentido si se quiere que los números de A salgan bien a la primera.

---

## Estado actual (lo que ya existe y hay que reutilizar)

| Pieza | Dónde | Sirve para |
|---|---|---|
| Escalas con fondeo/atraque | `src/core/callDetector.js`, `port_calls` | Presencia en puerto |
| Tramos entre puertos | `route_legs` | Corredores origen–destino |
| Enrutado marítimo A\* | `src/core/seaRoute.js` + `data/sea-grid.bin` | **B**: reconstruir el hueco |
| Calado por escala | `port_calls.draught_on_*` | Proxy de carga |
| Tráfico agregado por periodo | `getPortTraffic` en `src/core/analytics.js` | **A**: la serie observada |
| Llegadas por puerto de origen | `getPortOrigins` | **A**: contraste con país de origen |
| Escalas en ventana de fechas | `getPortCalls` | **A**: candidatos por fecha |
| Búsqueda por IMO/MMSI/nombre | `/vessels?q=` | Llegar desde un documento de transporte |

Puertos de Colombia ya en el seed: Cartagena, Buenaventura, Barranquilla, Santa
Marta, Puerto Bolívar, Turbo, Coveñas, Tumaco, San Andrés, Ciénaga.

---

## Decisiones ya tomadas (no rediscutir)

1. **Los datos aduaneros van en tablas propias**, no mezclados con `vessels` ni
   `port_calls`. Son otra fuente, con otra fiabilidad y otro ciclo de vida.
2. **Nada estimado entra en `vessel_positions`.** Los tramos reconstruidos van a
   su propia tabla. Meter posiciones inventadas en la tabla de observaciones
   envenenaría distancias, escalas, permanencias y todo lo que se derive.
3. **La carga transbordada y la zona franca se marcan, no se filtran en
   silencio.** Ver "Trampas".
4. **La correlación informa siempre su n.** Con pocos puntos mensuales es ruido,
   y hay que decirlo en la respuesta, no dejarlo a interpretación.

---

## Decisiones pendientes (hace falta respuesta antes de la Fase A2)

- [ ] **¿Qué dataset es?** Microdato público DIAN, declaraciones propias
      (Formulario 500), o ambos. Cambia qué columnas hay y si existe el BL.
- [ ] **¿En qué formato llega?** CSV, Excel, dump SQL, API. Y codificación
      (los ficheros DIAN suelen venir en Latin-1, no UTF-8).
- [ ] **¿Qué columnas trae exactamente?** Hace falta una cabecera de ejemplo con
      2–3 filas reales (pueden ir anonimizadas) para escribir el mapeo.
- [ ] **¿Qué identifica el puerto?** Código de aduana DIAN, nombre libre,
      UN/LOCODE. Determina la tabla de equivalencias de la Fase A2.
- [ ] **¿Hay marca de zona franca?** Si no la hay, hay que deducirla y eso es
      menos fiable.
- [ ] **Volumen aproximado de filas.** Miles frente a millones cambia si hace
      falta particionar.

---

## Fase B — Huecos de cobertura AIS  ✅ TERMINADA

**Por qué importa:** aisstream.io es AIS terrestre. Cubre bien las costas y mal
el océano abierto. Un buque desaparece días en medio del Pacífico y reaparece al
acercarse a tierra. Hoy el recorrido une esos dos puntos con una recta, que
además puede cruzar tierra, y la distancia sale corta.

### B1. Detectar el hueco

- [x] Umbral configurable `GAP_MIN_HOURS` (por defecto 6 h) en `src/config.js`.
- [x] Función en `src/core/gaps.js`: dadas dos posiciones consecutivas de un
      buque, es hueco si `Δt > GAP_MIN_HOURS`.
- [x] Distinguir el hueco **en mar** del hueco **en puerto**: si ambas posiciones
      caen en el radio del mismo puerto, no es un hueco de cobertura, es un buque
      amarrado que dejó de emitir. No reconstruir ese.

### B2. Reconstruir el trayecto

- [x] Ruta por mar entre la última posición conocida y la primera nueva, con
      `findSeaRoute` (ya existe, ya verificado que no cruza tierra).
- [x] Velocidad media implícita = distancia de esa ruta ÷ Δt, en nudos.
- [x] Duración en días = Δt / 86400, que es como pidió expresarse.
- [x] Comparar la velocidad implícita contra la `sog` media observada del buque
      antes y después del hueco.

### B3. Comprobar que es plausible

- [x] Rango plausible para mercantes: **1 a 25 nudos**. Fuera de ahí, marcar
      `plausible = false` y **no** dibujarlo como trayecto.
- [x] Una velocidad implícita imposible (>25 kn) no significa "barco rápido":
      significa que en el hueco pasó algo más — una escala que no se detectó, un
      MMSI compartido o suplantado, o un salto de datos. Se registra como
      sospechoso y se deja a la vista.
- [x] Velocidad implícita muy baja (<1 kn) sobre una distancia grande: mismo
      tratamiento.

### B4. Guardarlo separado

- [x] Tabla `vessel_gap_segments`: `mmsi`, `gap_start`, `gap_end`,
      `gap_seconds`, `gap_days`, `from_lat/lon`, `to_lat/lon`,
      `sea_route_nm`, `implied_speed_kn`, `plausible`, `path_points JSONB`.
- [x] **Nunca** insertar en `vessel_positions`.
- [x] Índice por `(mmsi, gap_start)`.

### B5. Exponerlo sin confundirlo con lo real

- [x] `getVesselTrack` devuelve además `gaps: [...]` y
      `distance_nm_with_gaps`, **sin tocar** `distance_nm`, que sigue siendo
      solo lo observado.
- [x] El visor dibuja los tramos estimados **discontinuos y en otro color**, con
      etiqueta "tramo estimado — el buque no emitió".
- [x] La respuesta dice cuántas horas y millas son estimadas frente a observadas.

### B6. Pruebas (`test/gaps.test.js`, 8 pruebas)

- [x] Hueco en mar abierto: se reconstruye, la velocidad implícita es razonable.
- [x] Hueco dentro del radio de un puerto: **no** se reconstruye.
- [x] Velocidad implícita imposible: `plausible = false` y no se dibuja.
- [x] El trayecto reconstruido no cruza tierra (misma verificación que
      `test/searoute.test.js`).
- [x] `distance_nm` sigue contando solo lo observado.

**Decisión tomada al implementar:** los huecos se calculan **al vuelo** en
`getVesselTrack`, no se persisten. La tabla `vessel_gap_segments` y `saveGaps()`
existen para cuando haga falta analítica masiva sobre huecos, pero mientras se
consulten de uno en uno es preferible calcularlos: nunca quedan obsoletos si
llegan posiciones atrasadas que rellenan el hueco.

**Fallos encontrados y corregidos durante la Fase B:**
- `db/schema.sql` definía `port_call_durations` dos veces; la segunda intentaba
  quitar columnas y `CREATE OR REPLACE VIEW` no puede, así que reaplicar el
  esquema sobre una base ya migrada fallaba.
- La demo generaba posiciones con **fecha futura** en los buques de travesías
  largas, y quedaban fuera de cualquier consulta de "últimos N días".
- El visor desenrollaba las longitudes del hueco en un marco distinto al de la
  traza; al juntarlos para encuadrar, la caja abarcaba el mundo y no se veía nada.

---

## Fase A — Declaraciones aduaneras

### A1. Esquema

- [ ] Tabla `customs_declarations` en `db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS customs_declarations (
    id                  BIGSERIAL PRIMARY KEY,
    source              TEXT NOT NULL,      -- 'dian_microdato' | 'formulario_500' | ...
    source_row_id       TEXT,               -- id en el origen, para poder recargar sin duplicar
    flow                TEXT NOT NULL CHECK (flow IN ('import', 'export')),
    declared_on         DATE NOT NULL,
    arrived_on          DATE,               -- llegada/embarque, si el origen la trae
    importer_nit        TEXT,
    importer_name       TEXT,
    hs_code             TEXT NOT NULL,      -- subpartida
    origin_country      TEXT,               -- ISO-2
    destination_country TEXT,
    customs_office_raw  TEXT,               -- aduana tal como viene
    port_raw            TEXT,               -- puerto tal como viene
    port_id             INTEGER REFERENCES ports(id),   -- resuelto en A2
    transport_mode      TEXT,               -- 'maritimo' | 'aereo' | 'terrestre'
    gross_weight_kg     NUMERIC,
    net_weight_kg       NUMERIC,
    fob_usd             NUMERIC,
    cif_usd             NUMERIC,
    transport_doc       TEXT,               -- BL, si existe
    free_zone           BOOLEAN NOT NULL DEFAULT FALSE,
    raw                 JSONB               -- la fila original, por si algo se mapeó mal
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customs_source_row
    ON customs_declarations (source, source_row_id) WHERE source_row_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customs_port_date ON customs_declarations (port_id, declared_on);
CREATE INDEX IF NOT EXISTS idx_customs_hs        ON customs_declarations (hs_code);
CREATE INDEX IF NOT EXISTS idx_customs_nit       ON customs_declarations (importer_nit);
```

- [ ] Índice único por `(source, source_row_id)` para que recargar el mismo
      fichero no duplique.

### A2. Resolver el puerto

- [ ] Tabla de equivalencias `customs_port_aliases (source, alias, port_id)`:
      el código o nombre de aduana que venga en el fichero, mapeado a `ports.id`.
- [ ] Sembrarla con las aduanas colombianas marítimas (Cartagena, Buenaventura,
      Barranquilla, Santa Marta, etc.).
- [ ] Lo que no resuelva se deja con `port_id NULL` y **se informa en el
      resumen de carga**, no se descarta en silencio.

### A3. Cargador

- [ ] `scripts/import-customs.js --file <ruta> --source <nombre> --map <perfil>`.
- [ ] Perfiles de mapeo de columnas en `db/customs-profiles/`, uno por formato,
      porque los ficheros DIAN no son homogéneos entre años.
- [ ] Manejar codificación Latin-1 y separador `;` (habitual en ficheros DIAN).
- [ ] Carga por lotes dentro de transacción, idempotente.
- [ ] Al terminar: filas leídas, insertadas, duplicadas, sin puerto resuelto,
      sin modo de transporte. **Que los descartes se vean.**

### A4. Correlación

- [ ] `getTradeCorrelation(portId, {from, to, bucket, hsCode, flow})` en
      `src/core/tradeCorrelation.js`:
  - serie aduanera: peso y valor por periodo,
  - serie observada: escalas, buques distintos, permanencia media,
    `avg_draught_delta_m`,
  - coeficiente de correlación de ambas series, **con su n**.
- [ ] Filtrar a `transport_mode = 'maritimo'` y `free_zone = false`. Informar
      cuántas filas se dejaron fuera por cada motivo.
- [ ] Si `n < 12` periodos: devolver el coeficiente pero con
      `reliable: false` y el porqué. Con 4 meses no hay correlación, hay ruido.

### A5. API

- [ ] `GET /trade/correlation?port_id=&from=&to=&bucket=month&hs=&flow=`
- [ ] `GET /trade/declarations?nit=&hs=&port_id=&from=&to=` (consulta directa)
- [ ] Todas las respuestas repiten qué se excluyó y por qué.

### A6. Pruebas

- [ ] Carga idempotente: pasar el mismo fichero dos veces no duplica.
- [ ] Filas sin puerto resoluble se cuentan y se informan.
- [ ] Zona franca y modo no marítimo quedan fuera de la correlación y se
      contabilizan aparte.
- [ ] Con n pequeño, `reliable: false`.
- [ ] Una serie construida a propósito correlacionada con otra da el
      coeficiente esperado.

---

## Trampas conocidas (leer antes de interpretar cualquier resultado)

1. **Zona franca.** En Colombia una venta a zona franca cuenta como exportación,
   pero la mercancía no sale del país y **ningún barco la mueve**. Si se
   correlacionan esas filas contra movimientos de buques, no aparecerán nunca y
   la correlación sale rota sin que se vea por qué. Por eso existe la columna
   `free_zone`.
2. **Transbordo.** Mucha carga no llega directa: llega transbordada en Cartagena,
   Panamá o Algeciras. El "país de origen" de la declaración no es el puerto del
   que zarpó el buque que la trajo.
3. **Cobertura AIS.** Sin AIS satelital hay huecos en océano abierto. Es lo que
   ataca la Fase B, pero reconstruir no es observar: los tramos estimados no
   deben entrar en ninguna estadística que se presente como medida.
4. **n pequeño.** Una empresa con unas pocas importaciones al año no produce
   ninguna correlación significativa contra el tráfico de un puerto que mueve
   miles de escalas. Sirve para estacionalidad y corredores, no para atribuir.
5. **El calado no es tonelaje.** Ya está documentado en el README, pero conviene
   repetirlo al cruzarlo con pesos declarados: hay dirección y magnitud
   relativa, no toneladas.

---

## Criterios de aceptación

**Fase B terminada cuando:**
- Un buque con un hueco de más de 6 h en mar abierto tiene su tramo
  reconstruido, con velocidad implícita y duración en días.
- Ese tramo no cruza tierra.
- `vessel_positions` no contiene ni una fila estimada.
- El visor distingue a simple vista lo observado de lo reconstruido.

**Fase A terminada cuando:**
- Un fichero real de declaraciones carga de forma idempotente y el resumen dice
  qué se resolvió y qué no.
- `GET /trade/correlation` devuelve las dos series y su coeficiente con n.
- Zona franca y modo no marítimo quedan fuera, contabilizados aparte.
- Existe una prueba que demuestra que recargar no duplica.

---

## Cómo retomar

1. Lee este documento entero y mira qué casillas están marcadas.
2. `npm install && npm run migrate && npm run seed && npm run demo`, y
   `npm run api` para tener algo delante.
3. `TEST_DATABASE_URL=postgres://... npm test` — deben pasar todas antes de
   tocar nada.
4. Si vas a la Fase A, **lo primero es resolver las "Decisiones pendientes"**:
   sin una cabecera real del fichero no se puede escribir el mapeo.
5. Convenciones del repo: comentarios y mensajes de commit en español, pruebas
   junto a cada pieza nueva, y todo lo inferido etiquetado como inferencia en la
   propia respuesta de la API.
