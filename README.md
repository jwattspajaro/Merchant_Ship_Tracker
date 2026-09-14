# Merchant Ship Tracker

Rastreo mundial de buques mercantes a partir de datos AIS. Filtra carga y tanque,
detecta llegadas y salidas de puerto distinguiendo fondeo de atraque, calcula
permanencia y tránsito, y estima rutas a partir de su propio histórico.

El sistema **acumula su propio histórico**: no depende de que un proveedor externo
calcule escalas, permanencias ni rutas. La fuente AIS solo aporta posiciones.

Código original. Licencia MIT (ver [LICENSE](LICENSE)).

---

## Puesta en marcha

Requisitos: **Node.js 18+** y **PostgreSQL 13+**. No hace falta PostGIS.

```bash
npm install
cp .env.example .env        # y rellena DATABASE_URL
npm run migrate             # esquema + particiones del mes en curso y los dos siguientes
npm run seed                # ~105 puertos de referencia
```

Tres procesos independientes:

```bash
npm run ingest              # cliente AIS -> base de datos (necesita AISSTREAM_API_KEY)
npm run api                 # API + visor en http://localhost:3000
npm run jobs                # mantenimiento diario: particiones y retención
```

Cada uno puede correr en su propia máquina; solo comparten la base de datos.

### Ver algo sin esperar

Sin clave AIS y sin histórico acumulado, el visor sale vacío. Para poder mirarlo
desde el primer minuto:

```bash
npm run demo                # buques ficticios navegando entre puertos del seed
npm run api                 # y abre http://localhost:3000
```

`npm run demo` genera **datos inventados** (MMSI y posiciones falsos) para probar
el visor y la API. No lo ejecutes sobre la base de producción.

---

## Visor

`npm run api` sirve un visor de mapa en `/`, además de la API. Lo sirve el propio
proceso a propósito: una página alojada en otro origen no puede consultar una API
en `localhost`, así que un visor externo no funcionaría.

- **Flota** — buques sobre el mapa, en azul los de carga y naranja los tanque.
  Al pinchar uno: su escala actual (atracado o fondeado), la permanencia, la
  ventana probable de carga con su advertencia, y el tramo en curso.
- **Recorrido** — al elegir un buque se dibuja en morado su traza real de los
  últimos 7, 30 o 90 días, con la distancia navegada. Solo muestra lo observado:
  si el sistema lleva menos tiempo en marcha que la ventana pedida, o las
  posiciones ya pasaron el horizonte de retención, la ficha lo dice.
- **Rutas** — eliges dos puertos y dibuja la ruta estimada. Verde continua si es
  la traza histórica de un viaje real, azul continua si es un camino por mar
  calculado, ámbar discontinua si es una recta no navegable. El panel dice cuál
  es y por qué.
- Los círculos verdes son los radios de aproximación: el "puerto", para este
  sistema, es ese círculo y no un punto.
- Se refresca cada 30 s.

Usa Leaflet y teselas de OpenStreetMap desde CDN, así que necesita salida a
internet para el mapa de fondo (los datos salen siempre de tu base). Las teselas
públicas de OSM valen para uso local; si lo despliegas para mucha gente, cambia
la capa por un proveedor propio.

### Pruebas

```bash
npm run test:unit           # lógica pura, sin base de datos
TEST_DATABASE_URL=postgres://... npm test    # + criterios de aceptación de la sección 8
```

La prueba de aceptación trabaja en un esquema aparte (`mst_test`) que borra y
recrea en cada pasada: no toca los datos de trabajo. Si no hay
`TEST_DATABASE_URL` ni `DATABASE_URL`, se omite con un mensaje explicando por qué.

---

## Cómo funciona

### 1. Filtrado (`src/lib/shipTypes.js`)

Solo el código `ShipType` del AIS (ITU-R M.1371) decide qué entra:

| Código | Etiqueta | Qué hace el sistema |
|--------|----------|---------------------|
| 70–79  | `Cargo`  | Se rastrea |
| 80–89  | `Tanker` | Se rastrea |
| resto  | —        | Se descarta |

Un MMSI **no guarda ni una sola posición** hasta que llega su mensaje
`ShipStaticData` confirmando un tipo entre 70 y 89. Pesca, pasaje, remolcadores,
recreo, SAR y WIG quedan fuera de la base de datos, no solo de las consultas.

### 2. Escalas de puerto (`src/core/callDetector.js`)

Máquina de estados que corre con cada posición nueva:

```text
                      posición fuera del radio de ESE puerto
   ┌────────────────┐ ───────────────────────────────────────► ┌──────────────┐
   │ escala abierta │   cierra port_call, abre route_leg        │ tramo abierto│
   └────────────────┘ ◄─────────────────────────────────────── └──────────────┘
                        posición dentro del radio de un puerto
                        cierra route_leg (destino, duración, traza)
```

Al entrar en el radio de aproximación de un puerto se abre un `port_call`
clasificado por la distancia al centroide:

- **< 30 % del radio → `berth`** (atracado, probablemente trabajando)
- **≥ 30 % del radio → `anchorage`** (fondeado, probablemente esperando turno)

Al cerrar un tramo se reconstruye `path_points` a partir de las posiciones
guardadas en esa ventana, recortada a **60 puntos equiespaciados**. Las
posiciones crudas siguen íntegras en `vessel_positions`; `path_points` es solo la
traza ligera para dibujar el tramo.

### 3. Operación de carga: lo que el AIS **no** puede decir

El AIS transmite posición, rumbo, velocidad y estado de navegación. **No dice si
un buque está cargando, descargando, ambas cosas, ni cuánta carga se movió.**

Por eso aquí no existe ninguna marca de tiempo de "inicio de descarga" ni ninguna
cantidad: se inventarían. Lo que sí se entrega:

- La escala de tipo `berth` **es** la ventana probable de operación de carga
  (`arrived_at` → `departed_at`).
- Su promedio histórico por puerto (`/ports/:id/dwell-stats`) es lo más cerca que
  se llega al "tiempo típico de desembarco" sin datos del operador portuario.

`GET /vessels/:mmsi/cargo-operations` responde **501** diciéndolo de forma
explícita, con la ventana inferida y la advertencia de que es una inferencia de
posición, no una confirmación de que se esté moviendo carga.

Para el dato real hay dos vías, y ninguna es AIS: integrar el **TOS/EDI** del
operador de terminal, o contratar un proveedor comercial de hitos de contenedor
(Gate-In / Loaded / Discharged / Departed). Eso está fuera de este alcance.

#### Lo único que el AIS sí deja inferir: el calado

El AIS **sí** transmite el calado máximo estático, y el calado cambia entre
cargado y en lastre. La diferencia entre la llegada y la salida de una escala
(`draught_delta_m`) es el mejor indicador de carga que se puede sacar del AIS, y
la API lo devuelve en `cargo_operations.draught_change` marcado con
`is_inference: true`.

Positivo = el buque salió más hundido (carga neta). Negativo = salió más ligero
(descarga neta). Por debajo de 10 cm no se distingue del ruido.

Cuatro razones por las que **no es una medida**, y van en la propia respuesta:

1. Lo teclea la tripulación a mano: se queda desactualizado o mal puesto.
2. Viene redondeado a 0,1 m.
3. De metros a toneladas hace falta la tabla hidrostática del buque (TPC), que el
   AIS no transmite. Hay **dirección y magnitud relativa, no tonelaje**.
4. El calado también cambia con el combustible, el lastre y la densidad del agua.

> La especificación original prohibía estimar carga desde el AIS. Se añadió por
> decisión posterior, para trabajo estadístico, y por eso va etiquetado como
> inferencia en cada respuesta en vez de mezclarse con lo observado.

### 4. Estimación de rutas (`src/core/routes.js`)

Para un par (origen, destino):

- **≥ 3 tramos cerrados** → `source: "historical"`. Se devuelve la traza real del
  tramo cuya duración está más cerca de la mediana, junto con su
  `transit_seconds`. No se promedian trazas: la media de varios caminos produce
  rutas que ningún buque recorrió.
- **< 3 tramos** → `source: "sea_route"`. Camino navegable calculado (abajo), con
  `distance_nm` y `transit_seconds: null`.
- **Si el enrutado falla** → `source: "great_circle"`, con un `routing_note` que
  dice en mayúsculas que no es navegable. Es el último recurso.

En `historical` cada punto es `[lat, lon, timestamp]`; en los otros dos es
`[lat, lon]` — un camino calculado no tiene horas.

> La especificación original pedía gran círculo cuando faltan tramos. Se cambió
> por decisión posterior: una recta entre dos puertos es la ruta de un avión y
> cruza continentes. El umbral de 3 tramos para pasar a histórica no cambió.

### 5. Enrutado marítimo (`src/core/seaRoute.js`)

`data/sea-grid.bin` (127 KB) es una máscara de bits del mar navegable a 0,25°
(~28 km), generada de los polígonos de tierra de Natural Earth (dominio público)
con `scripts/build-sea-grid.js`. Sobre ella corre un A\* con heurística de
distancia de gran círculo.

Tres cosas que el generador hace y verifica, en vez de suponer:

1. **Abre a mano los pasos más estrechos que una celda**: Panamá, Suez y todo el
   golfo de Suez, Gibraltar, Bósforo, estrechos daneses, Bab el-Mandeb, Ormuz,
   Malaca, Magallanes, Sunda y el Canal de la Mancha.
2. **Se queda solo con el océano conectado**, así el Caspio y los Grandes Lagos
   no aparecen como mar y cualquier par de celdas tiene camino garantizado.
3. **Comprueba que cada paso es transitable, no solo que el mar esté conectado.**
   Esa distinción importa: con el golfo de Suez cerrado, el Mar Rojo seguía
   conectado por Bab el-Mandeb y el Mediterráneo por Gibraltar —ambos daban
   "OK"— mientras un Dubái–Rotterdam se iba por el Cabo de Buena Esperanza. El
   generador falla si un paso no es transitable.

Las distancias salen dentro del 3 % de las tablas náuticas en travesías largas
(Rotterdam–Shanghái 10.499 NM frente a ~10.500; Nueva York–Los Ángeles 4.897 por
Panamá). En travesías cortas por pasos estrechos el error relativo es mayor
(Cartagena–Buenaventura da 624 NM frente a ~480): la rejilla obliga a rodeos que
un buque real no da.

**Lo que NO modela**, y conviene tener presente antes de usarlo para nada serio:
hielo y estacionalidad, calado, restricciones y peajes de canal, separación de
tráfico, zonas de guerra o piratería. Es un camino navegable por geometría, no un
plan de viaje.

Por defecto no enruta por encima de **70° de latitud**. Sin ese tope, el camino
más corto de Rotterdam a Singapur sale por la Ruta del Mar del Norte (9.100 NM
frente a 8.300 por Suez): navegable en verano, pero no es por donde va el
tráfico mercante. Súbelo con `SEA_ROUTE_MAX_LAT` si quieres rutas árticas.

---

## API

| Método | Ruta | Devuelve |
|--------|------|----------|
| GET | `/vessels` | Últimos mercantes vistos + su posición más reciente. `?type=Cargo\|Tanker`, `?q=` (IMO, MMSI o nombre), `?limit`, `?offset` |
| GET | `/vessels/:mmsi/dwell` | Escala actual o última, con `dwell_seconds` y `cargo_operations` |
| GET | `/vessels/:mmsi/current-leg` | Tramo en curso (sin destino todavía) |
| GET | `/vessels/:mmsi/track` | Recorrido observado. `?days=30` (1–365), con aviso de cobertura |
| GET | `/vessels/:mmsi/cargo-operations` | **501** — no disponible en esta fase, con el porqué |
| GET | `/ports` | Puertos de referencia. `?q=` para buscar |
| GET | `/ports/:id/dwell-stats` | Permanencia media, mediana, mín. y máx. por `call_type` |
| GET | `/ports/:id/calls` | Escalas en una ventana. `?from=&to=&type=berth\|anchorage` |
| GET | `/ports/:id/traffic` | Serie agregada por periodo + llegadas por origen. `?from=&to=&bucket=month` |
| GET | `/routes/:originPortId/:destinationPortId` | Ruta estimada (`historical` / `sea_route` / `great_circle`) + estadísticas |
| GET | `/health` | Estado del proceso y de la base de datos |

Ejemplo:

```bash
curl localhost:3000/routes/56/58
```

```json
{
  "origin":      { "id": 56, "unlocode": "NLRTM", "name": "Rotterdam" },
  "destination": { "id": 58, "unlocode": "DEHAM", "name": "Hamburg" },
  "source": "historical",
  "legs_considered": 3,
  "transit_seconds": 72000,
  "path_points": [[51.95, 4.14, "2026-09-04T04:00:00.000Z"], "..."],
  "transit_stats": { "legs": 3, "avg_transit_seconds": 81600, "median_transit_seconds": 72000 }
}
```

Las estadísticas de permanencia **solo cuentan escalas cerradas**: una escala
abierta todavía no tiene duración final y tiraría la media hacia abajo.

---

## Fuente de datos AIS

Toda la dependencia del proveedor vive en **un archivo**:
[`src/ingest/aisstream.js`](src/ingest/aisstream.js). Normaliza lo que llegue a
dos eventos (`static` y `position`) y el resto del sistema —esquema, detección,
analítica, API— no sabe de dónde salieron las posiciones.

**Desarrollo y pruebas: [aisstream.io](https://aisstream.io)**, gratuito.
Advertencia real: está en **beta, sin SLA publicado y sin términos comerciales
claros**. Sirve para construir y validar. No lo pongas debajo de un servicio que
le cobras a alguien.

**Producción:** cambiar esa capa por un proveedor con términos comerciales
explícitos. **Datalastic** (REST + histórico, autoservicio) es el más parecido en
forma. **SeaVantage** si además quieres hitos de contenedor y ETA predicha de
fábrica. Para añadir uno: un archivo nuevo en `src/ingest/` que emita los mismos
dos eventos, y un `case` en `createSource()`. Nada más cambia.

La ingesta aplica un intervalo mínimo por buque (`INGEST_MIN_INTERVAL_S`, 60 s por
defecto) para no guardar decenas de posiciones casi idénticas del mismo buque
parado. Súbelo para ahorrar espacio, bájalo a `0` para guardarlo todo.

---

## Retención y particionado

`vessel_positions` está particionada por mes. La tarea diaria (`npm run jobs`, a
las 03:00 locales por defecto):

1. Crea las particiones del mes en curso y los **dos siguientes**, si faltan.
2. Para cada mes entero ya más viejo que `RAW_RETENTION_DAYS` (90 por defecto):
   - lo **resume** en `vessel_daily_summary` (distancia navegada en millas
     náuticas, velocidad media y número de posiciones, por buque y día UTC);
   - **desconecta** la partición (`DETACH`, no `DROP`);
   - la **renombra** con sufijo `_archived`.

**El borrado definitivo es manual y separado, a propósito.** La tarea imprime el
`DROP TABLE` correspondiente y no lo ejecuta: una vez borrada la posición cruda,
ningún cálculo sobre ella se puede rehacer.

La distancia diaria encadena posiciones consecutivas **dentro del mismo día**: el
salto entre el último punto de un día y el primero del siguiente no se suma a
ninguno de los dos, para que ningún día se lleve millas que no navegó.

Si prefieres el cron del sistema o el Programador de tareas de Windows en vez de
un proceso vivo:

```bash
npm run job:partitions
npm run job:retention
```

---

## Decisiones y límites conocidos

- **Sin PostGIS.** `lat`/`lon` en `DOUBLE PRECISION` y Haversine en la capa de
  aplicación. La mejora futura evidente es sustituir el radio de aproximación por
  polígonos de puerto reales, que resolvería los dos límites siguientes; está
  fuera de este alcance.
- **El puerto es un círculo.** `approach_radius_m` es una aproximación grosera de
  la forma real de un puerto. Los del seed van de 8 a 15 km según lo extenso que
  sea el puerto; ajústalos con tu conocimiento local.
- **La clasificación `berth`/`anchorage` se fija al abrir la escala.** Un buque
  que pasa de fondeo a muelle en el mismo puerto sigue registrado como
  `anchorage` hasta que se va. Reclasificar en vivo es una mejora natural, pero
  cambia la semántica de "escala" y no está en la especificación.
- **Puertos con radios solapados.** Gana el centroide más cercano. Si un buque
  salta del radio de un puerto directamente al de otro entre dos posiciones, se
  registra un tramo de duración cero: es el reflejo honesto de que los radios se
  tocan o de que las posiciones llegaron muy espaciadas.
- **El enrutado marítimo es geométrico, no náutico.** Evita tierra y usa los
  canales, pero ignora hielo, calado, tráfico y restricciones. A 28 km de celda,
  una travesía corta por un paso estrecho puede desviarse un 30 %.
- **La carga que lleva un buque no está en el AIS.** Ni contenedores, ni
  manifiesto, ni consignatario. El AIS da posición, rumbo, velocidad y estado de
  navegación, y nada más. Buscar "el contenedor que va en tal barco" exige el
  TOS/EDI del operador de terminal o un proveedor de hitos de contenedor.

---

## Cruzar con documentación aduanera

Una declaración de importación trae fecha, puerto, subpartida, peso y valor,
pero **no el buque**. El AIS trae el buque pero **no la carga**. Se juntan por
dos vías, y conviene no confundirlas:

**Envío concreto (identificación).** Sólo con el documento de transporte:

```text
declaración → nº de BL + transportadora → manifiesto de carga → nave y viaje → IMO → este sistema
```

El microdato público de aduanas no basta: no lleva BL ni nave. Hace falta la
declaración en sí (que referencia el documento de transporte) o el manifiesto.
El número de contenedor va en el BL, no en la declaración.

**Correlación estadística.** No identifica envíos, y para eso no necesita el BL:

| Dato aduanero | Contrapartida observada |
|---|---|
| Peso y valor declarados por mes | `/ports/:id/traffic?bucket=month` — escalas, buques distintos, permanencia media |
| País de origen | `arrivals_by_origin` — de qué puertos llegaron los buques |
| Fecha de llegada + puerto | `/ports/:id/calls?from=&to=` — candidatos observados en esa ventana |
| Modo marítimo, tipo de mercancía | `cargo_calls` / `tanker_calls` en la serie |
| Volumen movido (aproximado) | `avg_draught_delta_m`, `calls_loaded`, `calls_discharged` — inferencia, no tonelaje |

Se correlacionan **series**, no envíos. Y con una advertencia que la API repite
en cada respuesta: lo observado es **presencia y tiempo de muelle, no tonelaje**.
Una escala atracada larga sugiere más trabajo que una corta, y nada más. Las
llegadas cuyo tramo de origen no se cerró se informan aparte en
`arrivals_without_known_origin` en vez de repartirse entre los orígenes
conocidos.
- **Los centroides del seed son aproximados** (~1–3 km), suficiente para radios de
  8–15 km. Sustitúyelos por un dataset UN/LOCODE propio si necesitas precisión.
- **La bandera se deriva del MID del MMSI**, no la transmite el AIS. Un MID fuera
  de la tabla devuelve `null` en vez de una suposición.
- **Las posiciones de un mismo buque se procesan en serie.** La máquina de
  estados de escalas depende del orden cronológico. La ingesta vuelca su cola en
  orden de llegada dentro de una transacción; dos procesos de ingesta escribiendo
  el mismo MMSI a la vez se pisarían. Dos índices únicos parciales
  (`idx_port_calls_one_open_per_vessel`, `idx_route_legs_one_open_per_vessel`)
  impiden que un buque acabe con dos escalas o dos tramos abiertos.
- **El campo `Destination` del AIS no se usa.** Lo escribe la tripulación a mano y
  a menudo está desactualizado o vacío. El destino se determina por observación,
  cuando el buque entra en el radio de un puerto.

---

## Estructura

```text
db/schema.sql            Esquema completo
db/seed_ports.sql        Puertos de referencia
src/config.js            Configuración por entorno
src/db.js                Pool de PostgreSQL, transacciones
src/lib/                 Geometría esférica, tipos AIS, estado de navegación, MID
src/core/portIndex.js    Índice de puertos en memoria, clasificación berth/anchorage
src/core/callDetector.js Máquina de estados de escalas y tramos (4.2)
src/core/analytics.js    Permanencia y tránsito (4.4)
src/core/routes.js       Estimación de rutas (4.5)
src/core/seaRoute.js     Enrutado marítimo A* sobre rejilla de mar
data/sea-grid.bin        Máscara de mar navegable (127 KB, generada)
scripts/build-sea-grid.js  Genera la rejilla desde Natural Earth
src/core/cargoOperations.js  Lo que el AIS no da (4.3)
src/ingest/aisstream.js  Capa de proveedor — el único archivo que cambia
src/ingest/index.js      Pipeline: filtro, cola, volcado por lotes
src/api/server.js        API de consulta + servidor del visor
public/index.html        Visor de mapa (Leaflet, sin build)
src/jobs/                Particiones, retención, planificador
scripts/demo.js          Datos ficticios para probar el visor
test/searoute.test.js    Enrutado: no cruza tierra, usa canales, distancias
test/unit.test.js        Lógica pura
test/acceptance.test.js  Criterios de aceptación de la sección 8
```
