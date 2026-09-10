/**
 * ELIMINAR_ARCHIVO.gs — Retirar un archivo hijo creado por equivocación.
 * ---------------------------------------------------------------------------
 * NO hace falta un disparador ni un agente que "reciba peticiones": la Web App
 * está desplegada con executeAs = USER_DEPLOYING, así que TODO el código del
 * servidor ya corre con la identidad del dueño. El botón del panel borra en el
 * momento, con el permiso del dueño, sin cola ni espera.
 *
 * Lo que sí hace falta es contención, porque esto destruye trabajo:
 *   · Solo Admin borra. El resto SOLICITA y queda registrado.
 *   · Solo se puede borrar lo que está EN EL PANEL: nunca un ID suelto de Drive.
 *   · Nunca se borra un archivo "Entregado": ya está consolidado en INVENTARIOS
 *     y REGISTRO, y quitarlo dejaría esos datos huérfanos sin origen.
 *   · Va a la PAPELERA, no a borrado permanente: 30 días para arrepentirse.
 *   · Todo queda en el registro de actividad, con motivo y quién lo pidió.
 */

var ELIM_CFG = {
  ACCION_SOLICITUD: "solicitud_eliminar_archivo",
  ACCION_BORRADO:   "eliminar_archivo",
  ROLES_SOLICITAR:  ["Admin", "Coordinador", "Líder de Conteo", "Lider de Conteo"]
};

/* ── Localiza el archivo DENTRO del panel ─────────────────────────────────
   Es la contención principal: si no está en el panel, no se toca. */
function _elimBuscarEnPanel(fileId) {
  var id = String(fileId || "").trim();
  if (!id) throw new Error("Indica el archivo a retirar.");

  var pan = _getSS().getSheetByName(CRON_CFG.HOJA_PANEL);
  if (!pan || pan.getLastRow() < 2) throw new Error("El panel está vacío.");

  var ancho = Math.max(CRON_CFG.PA_COL_RESP, CRON_CFG.PA_COL_UNID);
  var d = pan.getRange(2, 1, pan.getLastRow() - 1, ancho).getValues();

  for (var i = 0; i < d.length; i++) {
    var fid = extractIdFromUrl(d[i][CRON_CFG.PA_COL_ID - 1]) ||
              extractIdFromUrl(d[i][CRON_CFG.PA_COL_LINK - 1]);
    if (fid !== id) continue;
    return {
      hoja:        pan,
      fila:        i + 2,
      cliente:     String(d[i][CRON_CFG.PA_COL_CLIENTE - 1] || ""),
      fileId:      id,
      link:        String(d[i][CRON_CFG.PA_COL_LINK - 1] || ""),
      avance:      String(d[i][CRON_CFG.PA_COL_AVANCE - 1] || ""),
      responsable: String(d[i][CRON_CFG.PA_COL_RESP - 1] || ""),
      fechaInicio: d[i][CRON_CFG.PA_COL_FECHA_I - 1] || "",
      unidades:    parseFloat(d[i][CRON_CFG.PA_COL_UNID - 1]) || 0
    };
  }
  throw new Error("Ese archivo no está registrado en el PANEL DE CONTROL. " +
                  "Solo se pueden retirar archivos creados por el sistema.");
}

function _elimEsEntregado(avance) {
  return String(avance || "").toLowerCase().indexOf("entregado") !== -1;
}

/* ── Solicitudes pendientes leídas del registro de actividad ──────────────── */
function _elimSolicitudesPendientes() {
  var pend = {};
  try {
    var sh = _getSS().getSheetByName(USR_CFG.HOJA_LOG);
    if (!sh || sh.getLastRow() < 2) return pend;
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    for (var i = 0; i < v.length; i++) {
      var accion = String(v[i][2] || "");
      var fid    = String(v[i][3] || "").trim();
      if (!fid) continue;
      // Un borrado posterior cierra la solicitud de ese archivo.
      if (accion === ELIM_CFG.ACCION_BORRADO) delete pend[fid];
      else if (accion === ELIM_CFG.ACCION_SOLICITUD) {
        pend[fid] = { quien: String(v[i][1] || ""), cuando: v[i][0],
                      motivo: String(v[i][4] || "") };
      }
    }
  } catch (e) {}
  return pend;
}

/* ═══════════════════════════════════════════════════════════════════════════
   LISTAR — qué se puede retirar hoy
   ═══════════════════════════════════════════════════════════════════════════ */
function dash_listarArchivosEliminables() {
  _requiereRol(ELIM_CFG.ROLES_SOLICITAR);

  var pan = _getSS().getSheetByName(CRON_CFG.HOJA_PANEL);
  if (!pan || pan.getLastRow() < 2) return { archivos: [], mensaje: "El panel está vacío." };

  var ancho = Math.max(CRON_CFG.PA_COL_RESP, CRON_CFG.PA_COL_UNID);
  var d = pan.getRange(2, 1, pan.getLastRow() - 1, ancho).getValues();
  var pend = _elimSolicitudesPendientes();

  var yo = "";
  try { yo = String(_usuarioActual() || "").toLowerCase(); } catch (e) {}
  var puedeBorrar = false;
  try {
    var u = _obtenerUsuario(yo);
    puedeBorrar = !!(u && String(u.rol || "").trim().toLowerCase() === "admin");
  } catch (e) {}

  var out = [], entregados = 0;
  for (var i = d.length - 1; i >= 0; i--) {          // los más recientes primero
    var avance = String(d[i][CRON_CFG.PA_COL_AVANCE - 1] || "");
    if (_elimEsEntregado(avance)) { entregados++; continue; }   // intocables

    var fid = extractIdFromUrl(d[i][CRON_CFG.PA_COL_ID - 1]) ||
              extractIdFromUrl(d[i][CRON_CFG.PA_COL_LINK - 1]);
    if (!fid) continue;

    var s = pend[fid] || null;
    out.push({
      fileId:      fid,
      fila:        i + 2,
      cliente:     String(d[i][CRON_CFG.PA_COL_CLIENTE - 1] || ""),
      avance:      avance || "Pendiente",
      responsable: String(d[i][CRON_CFG.PA_COL_RESP - 1] || ""),
      fechaInicio: _elimFechaTxt(d[i][CRON_CFG.PA_COL_FECHA_I - 1]),
      unidades:    parseFloat(d[i][CRON_CFG.PA_COL_UNID - 1]) || 0,
      solicitud:   s ? { quien: s.quien, motivo: s.motivo } : null
    });
  }

  return {
    archivos: out,
    puedeBorrar: puedeBorrar,
    entregadosProtegidos: entregados,
    mensaje: out.length
      ? null
      : "No hay archivos retirables: todos los del panel están Entregados."
  };
}

function _elimFechaTxt(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "dd/MM/yyyy");
  }
  return String(v || "");
}

/* ═══════════════════════════════════════════════════════════════════════════
   SOLICITAR — para quien no es Admin
   ═══════════════════════════════════════════════════════════════════════════ */
function dash_solicitarEliminacionArchivo(fileId, motivo) {
  _requiereRol(ELIM_CFG.ROLES_SOLICITAR);
  var mot = String(motivo || "").trim();
  if (mot.length < 10) {
    throw new Error("Explica en pocas palabras por qué debe retirarse (mínimo 10 caracteres).");
  }

  var info = _elimBuscarEnPanel(fileId);
  if (_elimEsEntregado(info.avance)) {
    throw new Error("«" + info.cliente + "» está Entregado y ya se consolidó. " +
                    "No se puede retirar: los datos quedarían huérfanos en INVENTARIOS.");
  }

  _registrarActividad(_usuarioActual(), ELIM_CFG.ACCION_SOLICITUD, info.fileId,
    "Pide retirar «" + info.cliente + "» (fila " + info.fila + "). Motivo: " + mot);

  return { ok: true, cliente: info.cliente,
           mensaje: "Solicitud registrada. Un Administrador la verá en el panel de retiro." };
}

/* ═══════════════════════════════════════════════════════════════════════════
   RETIRAR — solo Admin. A la papelera, no a borrado permanente.
   ═══════════════════════════════════════════════════════════════════════════ */
function dash_eliminarArchivoCreado(fileId, motivo) {
  _requiereRol(["Admin"]);
  var mot = String(motivo || "").trim();
  if (mot.length < 10) {
    throw new Error("Escribe el motivo del retiro (mínimo 10 caracteres). Queda en el registro.");
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error("El sistema está ocupado (consolidación o creación en curso). Reintenta en unos segundos.");
  }

  try {
    var info = _elimBuscarEnPanel(fileId);

    // Guarda dura: lo consolidado no se toca.
    if (_elimEsEntregado(info.avance)) {
      throw new Error("«" + info.cliente + "» está Entregado y ya se consolidó en " +
                      "INVENTARIOS y REGISTRO. Retirarlo dejaría esos datos sin origen. " +
                      "Si de verdad hay que quitarlo, primero hay que deshacer la consolidación.");
    }

    var pasos = [];

    // 1) Archivo a la papelera (recuperable 30 días). Si ya no existe, se sigue.
    var nombre = "";
    try {
      var f = DriveApp.getFileById(info.fileId);
      nombre = f.getName();
      if (f.isTrashed()) pasos.push("El archivo ya estaba en la papelera.");
      else { f.setTrashed(true); pasos.push("Archivo enviado a la papelera."); }
    } catch (eD) {
      pasos.push("El archivo ya no existía en Drive (" + (eD.message || eD) + ").");
    }

    // 2) Quitar el enlace del CRONOGRAMA, sin borrar el evento: la tarea sigue
    //    programada, solo se queda sin archivo para que pueda rehacerse.
    try {
      var eventos = _elimLimpiarEnlaceCronograma(info.fileId);
      if (eventos) pasos.push("Enlace quitado de " + eventos + " evento(s) del cronograma.");
    } catch (eC) {
      pasos.push("No pude limpiar el cronograma: " + (eC.message || eC));
    }

    // 3) Fila del panel (al final: si algo falla antes, el rastro no se pierde)
    info.hoja.deleteRow(info.fila);
    pasos.push("Fila " + info.fila + " retirada del PANEL DE CONTROL.");

    _registrarActividad(_usuarioActual(), ELIM_CFG.ACCION_BORRADO, info.fileId,
      "Retiró «" + info.cliente + "»" + (nombre ? " (" + nombre + ")" : "") +
      (info.unidades ? " con " + info.unidades + " unidades contadas" : "") +
      ". Motivo: " + mot);

    return {
      ok: true,
      cliente: info.cliente,
      archivo: nombre,
      unidades: info.unidades,
      pasos: pasos,
      mensaje: "Retirado «" + info.cliente + "». El archivo está en tu papelera de Drive " +
               "y se puede restaurar durante 30 días."
    };
  } finally {
    lock.releaseLock();
  }
}

/* Deja en blanco la celda de archivo (col Q) de los eventos que apuntaban a él. */
function _elimLimpiarEnlaceCronograma(fileId) {
  var cron = _getSS().getSheetByName(CRON_CFG.HOJA_CRONOGRAMA);
  if (!cron) return 0;
  var n = cron.getLastRow() - CRON_CFG.CR_FILA_INI + 1;
  if (n < 1) return 0;

  var rango = cron.getRange(CRON_CFG.CR_FILA_INI, CRON_CFG.CR_COL_ARCH, n, 1);
  var rich  = rango.getRichTextValues();
  var val   = rango.getValues();
  var tocados = 0;

  for (var i = 0; i < n; i++) {
    var url = "";
    try { url = _extraerUrlSmartChip(rich[i][0], val[i][0]); } catch (e) { url = String(val[i][0] || ""); }
    if (!url) continue;
    if (extractIdFromUrl(url) !== fileId) continue;
    cron.getRange(CRON_CFG.CR_FILA_INI + i, CRON_CFG.CR_COL_ARCH).clearContent();
    tocados++;
  }
  return tocados;
}
