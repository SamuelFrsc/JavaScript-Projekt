// server.js
// ---------------------------
// BFF für "Intelligenter Posteingang"
// - verwaltet Ordner, Zustände & Metadaten
// - ruft den bereitgestellten Classifier-Mock (v1_0_1 / v1_1_0) auf
// - stellt REST-API fürs Frontend bereit
// ---------------------------

const { classifyByUuid } = require("./services/classifierClient.js");
let lastSyncedDocuments = [];

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fsPromises = fs.promises;
const { v4: uuidv4 } = require("uuid");

// node-fetch dynamisch importieren (funktioniert in CommonJS)
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());
app.use(cors());

// ---------------------------
// Konfiguration
// ---------------------------
const PORT = process.env.PORT || 3000;
const CLASSIFIER_BASE = process.env.CLASSIFIER_BASE || "http://localhost:8080";
const AUTO_PROCESS_THRESHOLD = parseFloat(process.env.AUTO_PROCESS_THRESHOLD || "0.80");
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || "7", 10);

// Projektordner
const ROOT = __dirname;
const INBOX_DIR = path.join(ROOT, "inbox");
const PROCESSING_DIR = path.join(ROOT, "processing");
const OUTBOX_DIR = path.join(ROOT, "outbox");
const HOLD_DIR = path.join(ROOT, "hold");
const DELETED_DIR = path.join(ROOT, "deleted");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "documents.json");
const NEEDS_REVIEW_DIR = path.join(ROOT, "needs-review");

// Ordner sicherstellen
[INBOX_DIR, PROCESSING_DIR, OUTBOX_DIR, HOLD_DIR, DELETED_DIR, DATA_DIR, NEEDS_REVIEW_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ---------------------------
// In-Memory "Datenbank" + Persistenz
// ---------------------------
/** documents: { [id]: Document } */
let documents = {};
loadDb();

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      documents = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    }
  } catch (e) {
    console.error("DB laden fehlgeschlagen:", e.message);
  }
}

async function saveDb() {
  try {
    await fsPromises.writeFile(DB_PATH, JSON.stringify(documents, null, 2), "utf-8");
  } catch (e) {
    console.error("DB speichern fehlgeschlagen:", e.message);
  }
}

// ---------------------------
// Upload (Multer) => /inbox
// ---------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, INBOX_DIR),
  filename: (req, file, cb) => {
    // Originalname behalten + UUID, um Kollisionen zu vermeiden
    const ext = path.extname(file.originalname) || ".pdf";
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${base}__${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    cb(ok ? null : new Error("Nur PDF erlaubt"), ok);
  },
});

// ---------------------------
// Hilfsfunktionen
// ---------------------------
function nowIso() {
  return new Date().toISOString();
}

function createDocForFile(filename, origin = "scanner") {
  const id = uuidv4();
  const doc = {
    id,
    filename,
    status: "inbox", // inbox | needs_review | processing | hold | processed | deleted
    origin, // 'scanner' | 'manual'
    confidence: null,
    metadata: {},
    mode: "auto", // auto | corrected | manual
    user: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  documents[id] = doc;
  return doc;
}

function filePathForStatus(doc) {
  switch (doc.status) {
    case "inbox":
      return path.join(INBOX_DIR, doc.filename);
    case "processing":
      return path.join(PROCESSING_DIR, doc.filename);
    case "processed":
      return path.join(OUTBOX_DIR, doc.filename);
    case "hold":
      return path.join(HOLD_DIR, doc.filename);
    case "deleted":
      return path.join(DELETED_DIR, doc.filename);
    case "needs_review":
      return path.join(NEEDS_REVIEW_DIR, doc.filename);
    default:
      return path.join(INBOX_DIR, doc.filename);
  }
}

async function moveDocFile(doc, targetDir) {
  const from = filePathForStatus(doc);
  const to = path.join(targetDir, doc.filename);
  // versuche rename, fallback: copy+unlink
  try {
    await fsPromises.rename(from, to);
  } catch {
    try {
      await fsPromises.copyFile(from, to);
      await fsPromises.unlink(from);
    } catch (e) {
      console.error("Datei verschieben fehlgeschlagen:", e.message);
      throw e;
    }
  }
}

async function writeOutboxMetadata(doc) {
  const metaPath = path.join(PROCESSING_DIR, `${doc.id}.json`);
  const payload = {
    id: doc.id,
    filename: doc.filename,
    status: doc.status,
    metadata: doc.metadata,
    confidence: doc.confidence,
    mode: doc.mode,
    user: doc.user,
    processedAt: nowIso(),
  };
  await fsPromises.writeFile(metaPath, JSON.stringify(payload, null, 2), "utf-8");
}

// --- NEU: DB-Dokument per filename finden/erzeugen & Mapping für Frontend

function findOrCreateDocByFilename(filename, origin = "scanner") {
  // versuche vorhandenes Doc zu finden
  for (const d of Object.values(documents)) {
    if (d.filename === filename) return d;
  }
  // nicht gefunden → neu anlegen (Scanner-Simulation)
  const doc = createDocForFile(filename, origin);
  return doc;
}

async function applyClassificationToDoc(doc, classification, user = "system") {
  doc.metadata = {
    ...doc.metadata,
    category: classification.category ?? doc.metadata.category,
    docId: classification.meta?.docId ?? doc.metadata.docId,
    subject: classification.meta?.subject ?? doc.metadata.subject,
    docDate: classification.meta?.docDate ?? doc.metadata.docDate,
  };

  if (typeof classification.confidence === "number") {
    doc.confidence = classification.confidence;
  }

  if (doc.confidence != null && doc.confidence < 0.60) {
  await moveDocFile(doc, NEEDS_REVIEW_DIR);   // zuerst verschieben
  doc.status = "needs_review";                // dann Status setzen
} else if (doc.confidence >= AUTO_PROCESS_THRESHOLD) {
  await moveDocFile(doc, PROCESSING_DIR);
  doc.status = "processed";
  await writeOutboxMetadata(doc);
} else {
  await moveDocFile(doc, INBOX_DIR);
  doc.status = "inbox";
}
  doc.mode = doc.mode === "manual" ? "manual" : "auto";
  doc.user = user;
  doc.updatedAt = nowIso();
}




function buildRowForFrontend(doc) {
  // Form für dein Frontend (/api/classify/sync-now Antwort)
  return {
    id: doc.id,                     // WICHTIG: internes DB-ID → damit /documents/:id/* wieder klappt
    fileName: doc.filename,         // Frontend erwartet fileName (großes N)
    status: doc.status,
    category: doc.metadata?.category || "Unklassifiziert",
    confidence: typeof doc.confidence === "number" ? doc.confidence : null,
    meta: {
      docId: doc.metadata?.docId || "",
      docDate: doc.metadata?.docDate || "",
      subject: doc.metadata?.subject || "",
      kind: doc.metadata?.category === "Rechnung"
        ? "INVOICE"
        : doc.metadata?.category === "Kontoauszug"
          ? "STATEMENT"
          : "LETTER",
    },
  };
}


// Classifier aufrufen (Mock entscheidet anhand letzter zwei UUID-Zeichen)
async function callClassifier(uuid) {
  const url = `${CLASSIFIER_BASE}/api/v1/classify/${uuid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Classifier HTTP ${res.status}`);
  return await res.json();
}

// Robust auf Metadaten mappen (v1_1_0 kann "korrupter" sein)
function mapClassifierResult(r) {
  const kindRaw = (r.kind || r.category || "").toString().toUpperCase();
  const category =
    kindRaw === "INVOICE" ? "Rechnung" :
      kindRaw === "STATEMENT" ? "Kontoauszug" :
        kindRaw ? kindRaw : "Sonstiges";

  const val = (obj, k) => obj?.[k] ?? obj?.[`${k}_val`] ?? null;
  const score = (obj, k) => {
    const s = obj?.[k] ?? obj?.[`${k}_score`];
    return typeof s === "number" ? s : null;
  };

  const docId = val(r, "doc_id");
  const docIdScore = score(r, "doc_id_score");

  const subject = val(r, "doc_subject");
  const subjectScore = score(r, "doc_subject_score");

  const docDate = r.doc_date_parsed || val(r, "doc_date_sic_val");
  const dateScore = score(r, "doc_date_sic_score");

  const scores = [docIdScore, subjectScore, dateScore].filter((s) => typeof s === "number");
  const confidence = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0.5;

  return {
    metadata: {
      category,
      docId: docId || undefined,
      subject: subject || undefined,
      docDate: docDate || undefined,
    },
    confidence,
  };
}

// ---------------------------
// Statische Serves (damit PDFs direkt angezeigt werden können)
app.use("/inbox", express.static(INBOX_DIR));
app.use("/outbox", express.static(OUTBOX_DIR));
app.use("/hold", express.static(HOLD_DIR));
app.use("/processing", express.static(PROCESSING_DIR));

// Frontend ausliefern (falls du frontend im selben Ordner hosten willst)
const FRONTEND_DIR = path.join(ROOT, "Frontend");
app.use("/", express.static(FRONTEND_DIR));


// ---------------------------
// API
// ---------------------------

app.get("/health", (req, res) => res.json({ ok: true }));

// Liste aller Dokumente (optional nach Status filtern)
app.get("/documents", (req, res) => {
  const { status } = req.query;
  const all = Object.values(documents).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const filtered = status ? all.filter((d) => d.status === status) : all;
  res.json(filtered);
});

// Nächstes Dokument (für z.B. needs_review)
app.get("/documents/next", (req, res) => {
  const status = req.query.status || "needs_review";
  const candidate = Object.values(documents)
    .filter((d) => d.status === status)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
  if (!candidate) return res.status(404).json({ error: "Kein Dokument im gewünschten Status" });
  res.json(candidate);
});

// Einzelnes Dokument
app.get("/documents/:id", (req, res) => {
  const doc = lastSyncedDocuments.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json(doc);
});

// Dokument aktualisieren (Metadaten, Confidence, Mode, Status)
app.put("/documents/:id", async (req, res) => {
  const user = req.header("X-User") || "unbekannt";
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  const { metadata, confidence, mode, status } = req.body || {};

  if (metadata && typeof metadata === "object") doc.metadata = { ...doc.metadata, ...metadata };
  if (typeof confidence === "number") doc.confidence = confidence;
  if (mode) doc.mode = mode;
  if (status) doc.status = status;

  doc.user = user;
  doc.updatedAt = nowIso();
  await saveDb();
  res.json(doc);
});

// Upload eines PDFs
app.post("/upload", upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Keine PDF erhalten" });
  const user = req.header("X-User") || "unbekannt";
  const doc = createDocForFile(req.file.filename, "manual");
  doc.user = user;
  await saveDb();
  res.status(201).json(doc);
});

// Klassifizieren
app.post("/documents/:id/classify", async (req, res) => {
  const user = req.header("X-User") || "unbekannt";
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    const uuid = uuidv4(); // Mock nimmt die letzten 2 Hex-Zeichen für Antwortmuster
    const raw = await callClassifier(uuid);
    const { metadata, confidence } = mapClassifierResult(raw);

    doc.metadata = { ...doc.metadata, ...metadata };
    doc.confidence = confidence;
    doc.mode = doc.mode === "manual" ? "manual" : "auto";
    doc.user = user;
    doc.updatedAt = nowIso();

    if (doc.confidence >= AUTO_PROCESS_THRESHOLD) {
      // Auto-Verarbeitung: nach /outbox + Metadaten-Datei
      await moveDocFile(doc, PROCESSING_DIR);
      doc.status = "processed";
      await writeOutboxMetadata(doc);
    } else {
      doc.status = "needs_review";
    }

    await saveDb();
    res.json(doc);
  } catch (e) {
    console.error("Classifier-Fehler:", e.message);
    res.status(502).json({ error: "Classifier nicht erreichbar", detail: e.message });
  }
});
// Re-Klassifizieren (gleich wie Klassifizieren, nur explizit)
app.post("/documents/:id/reclassify", async (req, res) => {
  const user = req.header("X-User") || "unbekannt";
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    const uuid = uuidv4();
    const raw = await callClassifier(uuid);
    const { metadata, confidence } = mapClassifierResult(raw);

    doc.metadata = { ...doc.metadata, ...metadata };
    doc.confidence = confidence;
    doc.mode = doc.mode === "manual" ? "manual" : "auto";
    doc.user = user;
    doc.updatedAt = nowIso();

    if (doc.confidence >= AUTO_PROCESS_THRESHOLD) {
      await moveDocFile(doc, PROCESSING_DIR);
      doc.status = "processed";
      await writeOutboxMetadata(doc);
    } else {
      doc.status = "needs_review";
    }

    await saveDb();
    res.json(doc);
  } catch (e) {
    console.error("Reclassify-Fehler:", e.message);
    res.status(502).json({ error: "Classifier nicht erreichbar", detail: e.message });
  }
});


// Kleiner Trick: route neu mappen auf die gleiche Logik:
// Klassifizieren
async function classifyHandler(req, res) {
  const user = req.header("X-User") || "unbekannt";
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    const uuid = uuidv4();
    const raw = await callClassifier(uuid);
    const { metadata, confidence } = mapClassifierResult(raw);

    doc.metadata = { ...doc.metadata, ...metadata };
    doc.confidence = confidence;
    doc.mode = doc.mode === "manual" ? "manual" : "auto";
    doc.user = user;
    doc.updatedAt = nowIso();

    if (doc.confidence >= AUTO_PROCESS_THRESHOLD) {
      await moveDocFile(doc, PROCESSING_DIR);   // bei dir war’s schon Processing statt Outbox
      doc.status = "processed";
      // optional: writeProcessingMetadata(doc);
    } else if (doc.confidence < 0.60) {
      await moveDocFile(doc, NEEDS_REVIEW_DIR);
      doc.status = "needs_review";
    } else {
      await moveDocFile(doc, INBOX_DIR); // bleibt in Inbox wenn kein Low-Confidence-Fall
      doc.status = "inbox";
    }


    await saveDb();
    res.json(doc);
  } catch (e) {
    console.error("Classifier-Fehler:", e.message);
    res.status(502).json({ error: "Classifier nicht erreichbar", detail: e.message });
  }
}

// beide Routen nutzen denselben Handler
app.post("/documents/:id/classify", classifyHandler);
app.post("/documents/:id/reclassify", classifyHandler);


// Manuelles Verarbeiten (z.B. nach Korrektur)
app.post("/documents/:id/process", async (req, res) => {
  const user = req.header("X-User") || "unbekannt";
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    await moveDocFile(doc, PROCESSING_DIR);
    doc.status = "processed";
    doc.mode = doc.mode === "manual" ? "manual" : "corrected";
    doc.user = user;
    doc.updatedAt = nowIso();
    await writeOutboxMetadata(doc);
    await saveDb();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: "Verarbeiten fehlgeschlagen", detail: e.message });
  }
});

// Hold / Warteposition
app.post("/documents/:id/hold", async (req, res) => {
  const user = req.header("X-User") || "unbekannt";
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    await moveDocFile(doc, HOLD_DIR);
    doc.status = "hold";
    doc.user = user;
    doc.updatedAt = nowIso();
    await saveDb();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: "Hold fehlgeschlagen", detail: e.message });
  }
});

// Löschen (verschieben nach /deleted, Sweeper räumt später endgültig weg)
app.post("/documents/:id/delete", async (req, res) => {
  const user = req.header("X-User") || "unbekannt";
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    await moveDocFile(doc, DELETED_DIR);
    doc.status = "deleted";
    doc.user = user;
    doc.updatedAt = nowIso();
    await saveDb();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ error: "Löschen fehlgeschlagen", detail: e.message });
  }
});

// ---------------------------
// Hintergrundjobs
// ---------------------------

// 1) Inbox-Scanner: alle 5s neue PDFs in /inbox => neues Dokument
setInterval(async () => {
  try {
    const files = await fsPromises.readdir(INBOX_DIR);
    // Nur PDFs
    const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf"));
    const known = new Set(Object.values(documents).map((d) => d.filename));
    let added = 0;
    for (const f of pdfs) {
      if (!known.has(f)) {
        createDocForFile(f, "scanner");
        added++;
      }
    }
    if (added) await saveDb();
  } catch (e) {
    console.error("Inbox-Scan Fehler:", e.message);
  }
}, 5000);

// 2) Retention Sweeper: alle 6h endgültig löschen, wenn >RETENTION_DAYS in deleted
setInterval(async () => {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const toDelete = [];
  for (const [id, doc] of Object.entries(documents)) {
    if (doc.status === "deleted") {
      const t = new Date(doc.updatedAt || doc.createdAt).getTime();
      if (t < cutoff) {
        toDelete.push({ id, filename: doc.filename });
      }
    }
  }
  for (const entry of toDelete) {
    try {
      await fsPromises.rm(path.join(DELETED_DIR, entry.filename), { force: true });
      delete documents[entry.id];
      console.log("🧹 endgültig gelöscht:", entry.id);
    } catch (e) {
      console.error("Endgültiges Löschen fehlgeschlagen:", e.message);
    }
  }
  if (toDelete.length) await saveDb();
}, 6 * 60 * 60 * 1000);

// 3) Auto-Cleaner: löscht alle "deleted"-Dokumente sofort alle X Minuten
const AUTO_DELETE_INTERVAL_MS = 60 * 1000; // 1 Minute – kannst du anpassen

setInterval(async () => {
  try {
    const toDelete = [];
    for (const [id, doc] of Object.entries(documents)) {
      if (doc.status === "deleted") {
        toDelete.push({ id, filename: doc.filename });
      }
    }

    for (const entry of toDelete) {
      try {
        // Datei im Deleted-Ordner löschen
        await fsPromises.rm(path.join(DELETED_DIR, entry.filename), { force: true });

        // Dokument aus DB entfernen
        delete documents[entry.id];

        console.log("🗑️ Auto gelöscht:", entry.id);
      } catch (e) {
        console.error("Auto-Löschen fehlgeschlagen:", e.message);
      }
    }

    if (toDelete.length) {
      await saveDb(); // Änderungen in documents.json sichern
    }
  } catch (e) {
    console.error("Auto-Cleaner Fehler:", e.message);
  }
}, AUTO_DELETE_INTERVAL_MS);




// ---------------Neuer api Code
// Neue Route: Klassifizierung + Dokumentliste
app.get("/api/classify/sync-now", async (req, res) => {
  try {
    const fs = await import("fs/promises");
    const path = await import("path");

    const inboxDir = path.join(process.cwd(), "inbox");
    const files = (await fs.readdir(inboxDir)).filter((f) =>
      f.toLowerCase().endsWith(".pdf")
    );

    const results = [];
    let dirty = false;

    for (const file of files) {
      const uuid = file.replace(/\.pdf$/i, "");
      try {
        const classification = await classifyByUuid(uuid);

        const dbDoc = findOrCreateDocByFilename(file, "scanner");
        await applyClassificationToDoc(dbDoc, classification, "system");
        dirty = true; // 🔽 wichtig

        results.push(buildRowForFrontend(dbDoc));
      } catch (err) {
        console.error("Classifier failed:", err.message);

        const dbDoc = findOrCreateDocByFilename(file, "scanner");
        results.push(buildRowForFrontend(dbDoc));
      }
    }

    if (dirty) await saveDb();   // 🔽 Änderungen sichern

    const qStatus = (req.query.status || "").trim();
    const allDocs = Object.values(documents).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const filtered = qStatus ? allDocs.filter(d => d.status === qStatus) : allDocs;

    const responseRows = filtered.map(buildRowForFrontend);
    lastSyncedDocuments = responseRows;

    return res.json({ documents: responseRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "sync failed" });
  }
});


//----------------Neuer api Code
// ---------------------------
// Start
// ---------------------------
app.listen(PORT, () => {
  console.log(`BFF läuft auf http://localhost:${PORT}`);
  console.log(`Classifier erwartet unter ${CLASSIFIER_BASE}`);
});