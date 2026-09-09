/**
 * DIAGNOSTICO_PROPIEDAD.gs — ¿De quién son los archivos y por qué?
 * ---------------------------------------------------------------------------
 * SOLO LEE. No crea, no comparte, no transfiere nada.
 *
 * Responde tres preguntas que deciden si se puede cambiar la propiedad:
 *   1. ¿Con qué identidad corre el código? (active vs effective)
 *   2. ¿Las carpetas están en Mi unidad o en una Unidad compartida?
 *      En una Unidad compartida NADIE es dueño individual: la pregunta
 *      "que cada uno sea dueño de lo suyo" deja de tener sentido.
 *   3. ¿Quién es dueño hoy de los archivos hijos y cuánto ocupa cada uno?
 *
 * Ejecutar desde el editor y mirar el Registro de ejecución.
 */

/** Llamada de lectura a Drive API v3 con el token del script. */
function _dpDrive(path) {
  var res = UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/" + path, {
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code < 200 || code >= 300) return { error: "HTTP " + code + ": " + body.substring(0, 160) };
  try { return JSON.parse(body); } catch (e) { return { error: "respuesta no JSON" }; }
}

function _dpBytes(n) {
  var b = parseFloat(n);
  if (isNaN(b)) return "—";
  var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (Math.round(b * 10) / 10) + " " + u[i];
}

function diagnosticarPropiedadArchivos() {
  var TOPE = 15;   // cuántos archivos hijos revisar (los más recientes del panel)
  var L = ["═══ PROPIEDAD DE ARCHIVOS — ITSANET IMS ═══\n"];

  /* 1) Identidad con la que corre el código ─────────────────────────────── */
  var act = "", eff = "";
  try { act = Session.getActiveUser().getEmail() || ""; } catch (e) {}
  try { eff = Session.getEffectiveUser().getEmail() || ""; } catch (e) {}
  L.push("1. IDENTIDAD DE EJECUCIÓN");
  L.push("   Usuario que hace clic (active)  : " + (act || "(vacío)"));
  L.push("   Usuario que ejecuta (effective) : " + (eff || "(vacío)"));
  L.push("   → El dueño de todo lo que se cree es el EFFECTIVE.");
  L.push(act && eff && act.toLowerCase() !== eff.toLowerCase()
    ? "   ⚠ Son distintos: la app corre como el dueño del despliegue."
    : "   Aquí coinciden porque lo ejecutas tú desde el editor;\n" +
      "     en la Web App el active es el operario y el effective el dueño.");

  /* 2) Cuota de Drive del dueño ─────────────────────────────────────────── */
  var about = _dpDrive("about?fields=storageQuota,user(emailAddress)");
  L.push("\n2. ALMACENAMIENTO DEL DUEÑO");
  if (about.error) L.push("   No pude leerlo (" + about.error + ")");
  else {
    var q = about.storageQuota || {};
    L.push("   Cuenta   : " + ((about.user || {}).emailAddress || "—"));
    L.push("   Usado    : " + _dpBytes(q.usage) +
           (q.limit ? "  de  " + _dpBytes(q.limit) : "  (sin límite declarado)"));
    L.push("   En Drive : " + _dpBytes(q.usageInDrive));
    L.push("   → Cada archivo hijo pesa sobre ESTA cuenta mientras sea su dueño.");
  }

  /* 3) Carpetas raíz: ¿Mi unidad o Unidad compartida? ───────────────────── */
  L.push("\n3. CARPETAS DESTINO");
  var raices = (typeof CONFIG === "object" && CONFIG.ROOT_FOLDER_IDS) || [];
  if (!raices.length) L.push("   CONFIG.ROOT_FOLDER_IDS está vacío.");
  var hayUnidadCompartida = false;
  raices.forEach(function (fid) {
    var f = _dpDrive("files/" + encodeURIComponent(fid) +
                     "?supportsAllDrives=true&fields=id,name,driveId,owners(emailAddress)");
    if (f.error) { L.push("   " + fid + " → " + f.error); return; }
    var enUC = !!f.driveId;
    if (enUC) hayUnidadCompartida = true;
    L.push("   " + f.name);
    L.push("      " + (enUC
      ? "UNIDAD COMPARTIDA (driveId " + f.driveId + ") — los archivos son de la organización"
      : "Mi unidad · dueño: " + (((f.owners || [])[0] || {}).emailAddress || "—")));
  });

  /* 4) Dueño real de los archivos hijos ─────────────────────────────────── */
  L.push("\n4. ARCHIVOS HIJOS (últimos " + TOPE + " del panel)");
  var porDueno = {}, revisados = 0, pesoTotal = 0;
  try {
    var pan = _getSS().getSheetByName(CRON_CFG.HOJA_PANEL);
    var ult = pan.getLastRow();
    if (ult < 2) L.push("   El panel está vacío.");
    var desde = Math.max(2, ult - TOPE + 1);
    var filas = (ult >= 2) ? pan.getRange(desde, 1, ult - desde + 1, 7).getValues() : [];

    filas.forEach(function (r) {
      var fid = extractIdFromUrl(r[CRON_CFG.PA_COL_ID - 1]);
      if (!fid) return;
      var f = _dpDrive("files/" + encodeURIComponent(fid) +
                       "?supportsAllDrives=true&fields=id,name,size,quotaBytesUsed,driveId,owners(emailAddress)");
      if (f.error) { L.push("   " + fid + " → " + f.error); return; }
      revisados++;
      var due = f.driveId ? "(unidad compartida)"
                          : (((f.owners || [])[0] || {}).emailAddress || "—");
      porDueno[due] = (porDueno[due] || 0) + 1;
      var peso = parseFloat(f.quotaBytesUsed || f.size || 0) || 0;
      pesoTotal += peso;
      L.push("   " + f.name + "\n      dueño: " + due + " · " + _dpBytes(peso));
    });
  } catch (e) {
    L.push("   No pude leer el panel: " + e.message);
  }

  L.push("\n   Resumen: " + revisados + " archivos · " + _dpBytes(pesoTotal) + " en total");
  Object.keys(porDueno).forEach(function (d) {
    L.push("      " + porDueno[d] + " × " + d);
  });

  /* 5) Veredicto ────────────────────────────────────────────────────────── */
  L.push("\n5. QUÉ SIGNIFICA");
  if (hayUnidadCompartida) {
    L.push("   Hay carpetas en Unidad compartida: ahí los archivos ya son de la");
    L.push("   organización y NO se puede (ni hace falta) transferir propiedad.");
    L.push("   El acceso se gobierna con la membresía de la unidad.");
  } else {
    L.push("   Todo está en Mi unidad del dueño del despliegue. Cada archivo");
    L.push("   creado suma a SU cuota y solo él puede eliminarlo definitivamente.");
    L.push("   Transferir propiedad al operario es posible dentro de @itsanet.com;");
    L.push("   con cuentas @gmail.com NO (Drive no permite el traspaso fuera del dominio).");
  }

  Logger.log(L.join("\n"));
  return { active: act, effective: eff, unidadCompartida: hayUnidadCompartida,
           revisados: revisados, porDueno: porDueno };
}
