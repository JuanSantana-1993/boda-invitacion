// importar.js
// Lee invitados.csv y sube cada familia a Firestore.
// Uso:  npm install   →   npm run importar

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const admin = require("firebase-admin");

// -------- CONFIGURA ESTO --------
const RUTA_CSV = "./invitados.csv";
const RUTA_LLAVE = "./service-account-key.json";
// Cambia esto por tu link real de GitHub Pages (el mismo que ya le mandaste a tu novia)
const BASE_URL = "https://tuusuario.github.io/boda-invitacion/index.html";
// ---------------------------------

if (!fs.existsSync(RUTA_LLAVE)) {
  console.error("❌ No encuentro service-account-key.json. Revisa el paso de la llave de administrador.");
  process.exit(1);
}
if (!fs.existsSync(RUTA_CSV)) {
  console.error(`❌ No encuentro ${RUTA_CSV}. Pon tu lista real ahí (usa invitados.csv como plantilla).`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(path.resolve(RUTA_LLAVE))),
});
const db = admin.firestore();

function generarId(nombre, idsUsados) {
  let base = nombre
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  let id = base;
  let contador = 2;
  while (idsUsados.has(id)) {
    id = `${base}-${contador}`;
    contador++;
  }
  idsUsados.add(id);
  return id;
}

async function importar() {
  const csvTexto = fs.readFileSync(RUTA_CSV, "utf-8");
  // los encabezados se leen sin acentos ni mayúsculas ("Niños" = "ninos")
  const normal = h => h.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");
  const filas = parse(csvTexto.replace(/^\uFEFF/, ""), {
    columns: cabecera => cabecera.map(normal), skip_empty_lines: true, trim: true, relax_column_count: true,
  });

  if (filas.length === 0) {
    console.log("El CSV no tiene filas, no hay nada que importar.");
    return;
  }

  // Consulta quién ya existe en Firestore ANTES de importar, para no
  // sobrescribir a nadie que ya haya respondido.
  const snapshotActual = await db.collection("familias").get();
  const idsUsados = new Set(snapshotActual.docs.map(d => d.id));
  let omitidos = 0;
  const resultados = [];

  for (const fila of filas) {
    const nombre = fila.contacto_nombre?.trim();
    const telefono = fila.contacto_telefono?.trim() || "";
    let adultos = parseInt(fila.adultos ?? fila.adulto, 10);
    let ninos = parseInt(fila.ninos ?? fila.nino, 10);
    // formato viejo: una sola columna personas_esperadas
    if (isNaN(adultos) && fila.personas_esperadas) { adultos = parseInt(fila.personas_esperadas, 10); ninos = 0; }
    if (isNaN(ninos)) ninos = 0;

    if (!nombre || isNaN(adultos) || adultos < 1 || ninos < 0) {
      console.warn(`⚠️  Fila inválida, se omite: ${JSON.stringify(fila)}`);
      continue;
    }

    const idTentativo = nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    if (idsUsados.has(idTentativo)) {
      console.log(`⏭️  ${nombre} ya existía, se omite.`);
      omitidos++;
      continue;
    }

    const id = generarId(nombre, idsUsados);
    const enEspera = ["si", "sí", "true", "1"].includes((fila.lista_espera ?? fila.lista_de_espera ?? "").toLowerCase());

    await db.collection("familias").doc(id).set({
      contacto_nombre: nombre,
      contacto_telefono: telefono,
      adultos,
      ninos,
      personas_esperadas: adultos + ninos,   // total (lo usan las reglas de seguridad)
      adultos_confirmados: 0,
      ninos_confirmados: 0,
      personas_confirmadas: 0,
      estado: "pendiente",
      nombres: [],
      alergias: "",
      mensaje: "",
      lista_espera: enEspera,
      creado_en: admin.firestore.FieldValue.serverTimestamp(),
    });

    const link = enEspera ? null : `${BASE_URL}?fam=${id}`;
    resultados.push({ contacto_nombre: nombre, adultos, ninos, link, lista_espera: enEspera });
    console.log(enEspera
      ? `⏳ ${nombre} (${adultos} adultos, ${ninos} niños) → en lista de espera, sin link todavía`
      : `✅ ${nombre} (${adultos} adultos, ${ninos} niños) → ${link}`);
  }

  // Guarda también un CSV con los links, listo para copiar/pegar a WhatsApp
  const encabezado = "contacto_nombre,adultos,ninos,link\n";
  const filasCsv = resultados
    .filter(r => !r.lista_espera)
    .map(r => `"${r.contacto_nombre}",${r.adultos},${r.ninos},${r.link}`)
    .join("\n");
  fs.writeFileSync("links-generados.csv", encabezado + filasCsv);

  console.log(`\n🎉 Listo. Se importaron ${resultados.length} familias nuevas, ${omitidos} ya existían (omitidas).`);
  console.log("Los links quedaron guardados en links-generados.csv");
}

importar().catch(err => {
  console.error("Ocurrió un error importando:", err);
  process.exit(1);
});
