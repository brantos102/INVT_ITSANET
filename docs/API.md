# ITSANET IMS — Referencia de las APIs

Documenta los **cuatro** niveles de API que usa el sistema. Cada método está
tomado del código real; el archivo y la función se citan para poder ir a
verificarlo.

```
Navegador (asistente/panel)
   │  google.script.run.<funcion>
   ▼
Apps Script  ── UrlFetchApp ──►  API ITSANET (ERP)   q_apidepot / g_apidepot
   │                                                  gettoken · getstock
   └─────────── REST ─────────►  Supabase (Data API)

Navegador (KPIs, solo lectura)
   │  /api/proxy?ruta=…
   ▼
Vercel (proxy)  ──►  Railway (Express)  ──►  Supabase (service_role)
```

Regla que atraviesa todo: **las claves nunca viajan al navegador**. En Apps
Script viven en ScriptProperties; en Railway, en variables de entorno; el proxy
de Vercel añade el token del lado servidor.

---

## 1. API ITSANET (ERP) — la externa

Dos bases, una por sede. Es la **única** diferencia de fondo entre ambos
módulos; el resto de la lógica es idéntica.

| Sede | Constante | Base URL | Archivo |
|---|---|---|---|
| Quito | `ITSANET_BASE` | `https://ec.itsanet.com/q_apidepot` | `ITSANET_API.gs.js` |
| Guayaquil | `ITSANET_BASE_GYE` | `https://ec.itsanet.com/g_apidepot` | `ITSANET_API_GYE.js` |

El almacén del que lee cada base es distinto en el ERP (Quito `/GTWV400`,
Guayaquil `/GGTWV400`). Eso lo resuelve el propio endpoint: el código solo
cambia la base y las credenciales.

### `GET /gettoken`

Autenticación. Devuelve el token del día para **un cliente**.

**Cabeceras**

| Cabecera | Contenido |
|---|---|
| `userid` | usuario API del cliente |
| `password` | clave API del cliente |

**Respuesta** — se acepta cualquiera de estas cuatro claves, en este orden:
`token` · `Token` · `Result` · `result`.

```js
// ITSANET_API.gs.js → obtenerORenovarTokenWMS(cliente)
var resToken = UrlFetchApp.fetch(ITSANET_BASE + "/gettoken", {
  method: "get",
  headers: { userid: creds.user, password: creds.pass },
  muteHttpExceptions: true
});
```

**Caché: un token por día y por cliente.** La fecha se calcula en `GMT-5`. Si
`FECHA_TOKEN_<CLIENTE>` es la de hoy, se reutiliza el guardado y no se llama al
ERP. Guardar o borrar una credencial invalida su token para forzar la
renovación.

Error si no llega token: `Error token <CLIENTE>. HTTP <code> -> <primeros 100 caracteres>`.

### `GET /getstock`

Stock completo del cliente cuyo token se presenta. **No recibe parámetros**: el
filtrado por SKU, por posición y por cliente se hace después, en Apps Script.

**Cabeceras**

| Cabecera | Contenido |
|---|---|
| `token` | el token del día (`.trim()`) |

**Respuesta** — array plano, o un objeto con el array en `Result`, `result` o
`data`. Un cuerpo vacío **no** es error: la bodega puede no tener stock, por eso
se protege el `JSON.parse` (si no, reventaba con *Unexpected end of JSON input*).

Devuelve siempre `{ code, body }` sin lanzar, para poder distinguir un 401 de
una bodega vacía:

```js
function consultarStockItsanet(cliente) { … return { code: res.getResponseCode(), body: res.getContentText() }; }
```

### Campos del ERP → formato rM (17 columnas)

`_filaRmDesdeStock(o)` en `ITSANET_API.gs.js:316`. Los índices vacíos quedan en
`""` y los llena el asistente.

| idx | Campo del ERP | Contenido |
|---|---|---|
| 4 | `COD. CLIENTE` | código del cliente **en el ERP** |
| 6 | `COD. PRODUCTO` | SKU |
| 7 | `DESCRIPCION` | descripción |
| 8 | `NRO. SERIE` | serie |
| 9 | `NRO. LOTE` | lote |
| 10 | `NRO. DESPACHO` | despacho |
| 11 | `NRO. PARTIDA` | partida |
| 12 | `CAT. LOG.` | categoría logística |
| 13 | `EST. MERC.` | estado de mercancía |
| 14 | `NAVE`-`CALLE`-`COLUMNA`-`NIVEL` | posición, unida con `-` omitiendo vacíos |
| 15 | `UNIDAD` | unidad de medida |
| 16 | `CANTIDAD` | `parseFloat`, `0` si no es número |

**Regla 1 SERIE = 1 UNIDAD.** Una fila con serie es un ítem físico único:
cantidad forzada a 1, nunca se agrupa, y un duplicado exacto
(serie+SKU+lote+posición) se descarta. Una fila sin serie sí consolida por
SKU+lote+despacho+partida+posición sumando cantidades.

### ⚠ `COD. CLIENTE` no es el nombre de la credencial

En el maestro del ERP, **código y razón social son campos distintos**:

| COD. CLIENTE | RAZÓN SOCIAL |
|---|---|
| `NOKIA5G` | NOKIA 5G |
| `NOKIACNT3G` | NOKIACNT3G |
| **`NOKIACNT`** | **NOKIACNTLTE** ← la credencial se llama así |

La credencial `NOKIACNTLTE` devuelve sus filas etiquetadas `NOKIACNT`. Si se
filtra por el nombre de la credencial, se descartan **todas**.

Lo resuelve `_extraerStockConAlias()` (`ITSANET_MULTI.js`): cuando una
credencial responde filas y **todas** se descartan por el nombre, detecta el
código real en `reporte.clientesDetalle` y repite la consulta aceptándolo. El
parentesco por prefijo (`NOKIACNT` ⊂ `NOKIACNTLTE`) manda sobre la familia por
raíz, y nunca toma un código que ya se pide aparte con su propia credencial. El
alias queda registrado en `reporte.aliasERP`.

---

## 2. Capa Apps Script — lo que llama el navegador

Se invocan con `google.script.run.<funcion>(…)`. El parámetro `base` acepta
`"GYE"`, `"GUAYAQUIL"` o `"G"` para Guayaquil (`_baseEsGYE`); **cualquier otro
valor va a Quito**, que es el comportamiento por defecto.

### Extracción de stock

| Función | Parámetros | Devuelve |
|---|---|---|
| `previsualizarStockRouter` | `(base, cliente, listaCodigos, incluirVariantes)` | `{ datosLimpios, reporte }` |
| `previsualizarStockMulti` | `(base, clientes[], codigos, variantes)` | `{ datosLimpios, reporte }` combinado |

`listaCodigos` acepta un array o un texto separado por espacios, comas, punto y
coma o saltos de línea (`_setCodigos`). Vacío = todo el stock.
`incluirVariantes` acepta además los SKU que **empiezan** por cada código pedido.

`previsualizarStockMulti` consulta cada cliente con **su** credencial y su
token, y combina sin repetir: la clave de deduplicación es
`SKU|serie|lote|posición`.

**Campos añadidos al `reporte` en el flujo multi**

| Campo | Contenido |
|---|---|
| `porCliente[]` | `{ cliente, filas, unidades, codigoERP, error? }` |
| `clientesPedidos[]` | los que se seleccionaron |
| `clientesEfectivos[]` | los `COD. CLIENTE` **reales** con los que llegaron las filas |
| `aliasERP[]` | `{ cliente, codigosERP[] }` cuando el ERP usó otro código |
| `erroresPorCliente[]` | un cliente sin stock o sin credencial no tumba a los demás |
| `clientesDetalle[]` | `{ cliente, filas }` contado **antes** del filtro |

`clientesEfectivos` es el que hay que pasar luego a la validación: con el nombre
de la credencial, las filas se volverían a descartar.

### Cronograma de códigos

| Función | Parámetros | Notas |
|---|---|---|
| `obtenerCodigosProgramadosRouter` | `(base, cliente, mes)` | mes en mayúsculas: `ENERO`…`DICIEMBRE` |
| `obtenerCodigosProgramadosMulti` | `(base, clientes[], mes)` | une los códigos sin repetir |
| `obtenerMesesDeCodigosRouter` | `(base, cliente, listaSkus[])` | `{ "SKU": ["JULIO"], … }` |
| `obtenerResumenCronCodigosRouter` | `(base)` | `[{ cliente, codigos }]` |
| `actualizarCronogramaCodigosRouter` | `(base, cliente, textoPegado)` | **rol Coordinador**; reemplaza el bloque del cliente |

Respuesta con códigos: `{ existe:true, mes, codigos[], total, abc:{}, totalCliente }`.

Respuesta **sin** códigos, con el contexto que necesita el asistente:

| Campo | Contenido |
|---|---|
| `existe` | `false` |
| `cliente`, `mes` | normalizados en mayúsculas |
| `puedeCargar` | permiso `baseDatos` del usuario (hoy solo Admin) |
| `clientesConCodigos[]` | los que sí tienen cronograma en esa sede |
| `sinCodigos[]` | *(solo multi)* los seleccionados que no aportaron nada |

`actualizarCronogramaCodigos` acepta TSV pegado desde Excel, `;` o `,`, con
columnas `ABC | CÓDIGO | ENERO…DICIEMBRE` (la columna ABC es opcional).

### Credenciales — todas exigen rol Coordinador

Admin pasa cualquier control de rol (es súper-usuario en `_requiereRol`).

| Función | Parámetros | Devuelve |
|---|---|---|
| `guardarCredencialAPIRouter` | `(base, cliente, usuario, password)` | `{ ok, cliente }` |
| `eliminarCredencialAPIRouter` | `(base, cliente)` | `{ ok, cliente }` |
| `listarClientesAPIRouter` | `(base)` | `{ clientes:[{cliente, usuario}] }` — **nunca** las claves |

### Clientes y agrupación

| Función | Parámetros | Devuelve |
|---|---|---|
| `sugerirClientesRelacionados` | `(base, cliente)` | `{ raiz, cliente, relacionados[], hayGrupo, exacto, todos[] }` |
| `listarGruposDeClientes` | `(base)` | `{ base, grupos:[{raiz, clientes[], total}], totalClientes }` |
| `obtenerEventosCronogramaMulti` | `(clientes[], opciones)` | eventos de todos, sin repetir, ordenados por fecha |

`_raizCliente()` toma las letras iniciales antes del primer dígito, cortadas a
`RAIZ_MAX = 5`. Ese tope es lo que agrupa `NOKIA5G`, `NOKIACNT3G` y
`NOKIACNTLTE` bajo `NOKIA`. El grupo es **una sugerencia**: el usuario marca
cuáles quiere contar.

### Validación

```
validarCSVAvanzado(csvData, clienteSeleccionado)
```

`clienteSeleccionado` acepta **un string o un array**. Con array de 2 o más se
acepta la fila que coincida con **cualquiera** de ellos; con uno solo, el
comportamiento es exactamente el de siempre. Tope: 50 000 filas.

---

## 3. API Railway (Express → Supabase)

`api/src/index.js` en la rama `codigo-en-vivo`. **Solo lectura**: la operación
vive en Apps Script, con su login y su árbol de roles.

**Autenticación** — `Authorization: Bearer <API_TOKEN>` o `x-api-token`. Si
`API_TOKEN` no está configurado, las rutas quedan abiertas. `/health` y `/`
nunca piden token.

| Ruta | Token | Parámetros | Devuelve |
|---|---|---|---|
| `GET /` | no | — | índice de rutas y tablas |
| `GET /health` | no | — | `{ ok, tokenConfigurado, tokenLen, error }` |
| `GET /api/:tabla` | sí | ver abajo | `{ datos, total, limit, offset }` |
| `GET /resumen` | sí | — | conteo por tabla + `actualizado` |
| `GET /analitica` | sí | `base` | `{ kpis, tendencia, clientes, atrasados, responsables, … }` |
| `GET /calidad` | sí | `base`, `anio` | `{ meses, totales, clientes, motivos, discrepancias, … }` |

**Tablas permitidas:** `panel_de_control`, `inventarios`, `registro`,
`clientes`, `cronograma`, `equipo`. Cualquier otra da 404.

**Parámetros de `/api/:tabla`**

| Parámetro | Efecto |
|---|---|
| `limit` | por defecto 100, **tope 5000** |
| `offset` | desplazamiento |
| `order` | `campo.desc` o `campo.asc` |
| `select` | columnas; por defecto `*` |
| *cualquier otro* | filtro de igualdad — si el valor lleva `%`, pasa a `ilike` |

`/analitica` y `/calidad` agregan **en el servidor** a propósito: bajar 125 000
filas al navegador no es viable. `/calidad` lee las vistas SQL de
`supabase/vistas_calidad.sql`; si no se han creado, responde 400 con esa pista.
La meta de exactitud está fijada en `META = 99.5`, igual que en Power BI.

---

## 4. Proxy Vercel

`web/api/proxy.js`. Existe para que `API_TOKEN` viva **solo** en el servidor de
Vercel y nunca viaje al navegador.

```
GET /api/proxy?ruta=<destino>&<resto de parámetros>
```

| `ruta` | Destino en Railway |
|---|---|
| `resumen` | `/resumen` |
| `analitica` | `/analitica` |
| `calidad` | `/calidad` |
| `<tabla>` o `<tabla>/<id>` | `/api/<tabla>[/<id>]` — `id` solo dígitos |
| `diag` | no reenvía: compara la longitud del token de Vercel con la de Railway |

Cualquier otra `ruta` da 404. **Todo método distinto de GET da 405**: el panel
es de solo lectura.

Se usa `?ruta=` y no una ruta comodín (`[...ruta].js`) porque es la forma que
Vercel resuelve sin ambigüedad.

---

## 5. Supabase desde Apps Script

`SUPABASE.js`. Lee `SUPABASE_URL` y `SUPABASE_ANON_KEY` de ScriptProperties.

```
_supabaseFetch(path, method, body, prefer)  →  {url}/rest/v1/{path}
```

Cabeceras: `apikey`, `Authorization: Bearer <key>`, `Content-Type`, `Prefer`
(por defecto `return=representation`). Devuelve `{ code, body }` sin lanzar.

Ejemplos en el propio archivo: `migrarClientesASupabase()` hace *upsert* con
`?on_conflict=nombre,base` y `Prefer: return=minimal,resolution=merge-duplicates`;
`migrarPanelASupabase()` hace refresco completo (DELETE + INSERT por lotes de 200).

---

## 6. Dónde viven las claves

Todo en **ScriptProperties** del proyecto Apps Script. No se copian al duplicar
un archivo de Drive: una copia de desarrollo aparece sin credenciales aunque el
código sea idéntico.

| Llave | Contenido |
|---|---|
| `CRED_API_<CLIENTE>` | `{"user":…,"pass":…}` de Quito |
| `CREDGYE_API_<CLIENTE>` | `{"user":…,"pass":…}` de Guayaquil |
| `ITSANET_TOKEN_<CLIENTE>` / `FECHA_TOKEN_<CLIENTE>` | token del día, Quito |
| `ITSANET_TOKEN_GYE_<CLIENTE>` / `FECHA_TOKEN_GYE_<CLIENTE>` | token del día, Guayaquil |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Supabase |

Para traspasarlas entre proyectos: `MIGRAR_CREDENCIALES.js` las pasa por un
archivo temporal de Drive y lo manda a la papelera al terminar. Nunca por
copiar y pegar: el registro trunca los textos largos y pegar claves dentro del
código las deja escritas en el proyecto.

---

## 7. Diagnóstico

| Función | Archivo | Para qué |
|---|---|---|
| `diagnosticarERP()` | `DIAGNOSTICO_ERP.js` | separa las 3 causas de "no trae datos": token / bodega vacía / filtro de cliente |
| `listarClientesConStock()` | `DIAGNOSTICO_ERP.js` | qué `COD. CLIENTE` existen en la sede y con cuántas filas |
| `probarConexionItsanet()` · `_GYE()` | `ITSANET_API*.js` | token + `getstock` + ejemplo de fila |
| `verificarCredenciales()` | `MIGRAR_CREDENCIALES.js` | qué clientes hay por sede, **sin** mostrar claves |

`diagnosticarERP()` es la que resuelve el caso del alias: imprime cada
`COD. CLIENTE` recibido con un ✓/✕ según lo acepte o no el filtro.

### Errores frecuentes

| Mensaje | Causa real |
|---|---|
| `No hay credenciales API para 'X'` | la credencial no está en **esa** sede (las llaves son distintas) |
| `Error token X. HTTP 401` | usuario o clave del ERP incorrectos |
| `No hay stock para el cliente "X"` | bodega vacía, **o** el ERP usa otro `COD. CLIENTE` sin parentesco detectable |
| `La respuesta del servidor no es válida` | cuerpo no-JSON, típicamente bodega inactiva |
| `CLIENTE_NO_MATCHEA` en validación | se validó con el nombre de la credencial y no con `clientesEfectivos` |
