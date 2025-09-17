// server.js

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fsPromises from "fs/promises"; // ganz oben importieren

const app = express();
app.use(bodyParser.json());
app.use(cors());

// __dirname nachbauen (weil ES-Module)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Mock-Ordner ----
const SCANNER_DIR = "./scanner";
const INBOX_DIR = "./inbox";
const PROCESSING_DIR = "./processing";
const DELETED_DIR = "./deleted";

// ---- In-Memory Store für Dokumente ----
let documents = {};

// 🆕 Initialisiere Dokumente aus dem Inbox-Ordner
const initFromInbox = async () => {
  console.log("📥 initFromInbox gestartet...");

const inboxFiles = await fsPromises.readdir(path.join(__dirname, "inbox"));
console.log("📁 Gefundene Dateien:", inboxFiles);


  inboxFiles.forEach((file) => {
    // Nur PDF-Dateien hinzufügen
    if (file.endsWith(".pdf")) {
     const id = file.replace(/\.pdf$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");

      if (!documents[id]) {
        documents[id] = {
          id,
          filename: file,
          status: "inbox",
          metadata: {},
          confidence: null,
          user: "system", // oder leer lassen
        };
      }
    }
  });
};


// 🧪 Starte Initialisierung beim Serverstart
initFromInbox();
// Prüft alle 5 Sekunden auf neue Dateien im Inbox-Ordner
setInterval(() => {
  initFromInbox();
}, 5000); // alle 5 Sekunden


// Dummy-Testdaten (nur für Entwicklung)
// documents = {
//   "doc1": {
//     id: "doc1",
//     filename: "rechnung_test.pdf",
//     status: "inbox",
//     metadata: { category: "Rechnung" },
//     confidence: 0.8,
//     user: "samuel"
//   },
//   "doc2": {
//     id: "doc2",
//     filename: "kontoauszug_test.pdf",
//     status: "inbox",
//     metadata: { category: "Kontoauszug" },
//     confidence: 0.65,
//     user: "samuel"
//   }
// };

const generateId = () => Math.random().toString(36).substring(2, 9);

//
// ---- API-Routen ----
//

// Alle Dokumente (optional Filter)
app.get("/documents", (req, res) => {
  const docs = Object.values(documents);
  res.json(docs);
});


// Einzelnes Dokument
app.get("/documents/:id", (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });
  res.json(doc);
});

// Manuelles Dokument hinzufügen
app.post("/documents/manual", (req, res) => {
  const { filename, user } = req.body;
  const id = generateId();
  documents[id] = {
    id,
    filename,
    status: "inbox",
    metadata: {},
    confidence: null,
    user,
  };
  res.status(201).json(documents[id]);
});

// Dokument updaten (Metadaten ändern)
app.put("/documents/:id", (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });
  documents[req.params.id] = { ...doc, ...req.body };
  res.json(documents[req.params.id]);
});

// Dokument löschen (markieren)
app.delete("/documents/:id", (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });
  doc.status = "deleted";
  res.json({ message: "Document marked for deletion", doc });
});

// Klassifizieren (Mock-Logik)
app.post("/documents/:id/classify", (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  const fakeResult = {
    category: "Rechnung",
    confidence: parseFloat(Math.random().toFixed(2)),
  };

  doc.metadata = { ...doc.metadata, category: fakeResult.category };
  doc.confidence = fakeResult.confidence;
  doc.status = doc.confidence > 0.7 ? "processing" : "needs_review";

  res.json(doc);
});

// Neu klassifizieren
app.post("/documents/:id/reclassify", (req, res) => {
  return app._router.handle(
    { ...req, url: `/documents/${req.params.id}/classify`, method: "POST" },
    res
  );
});

// Dokument in Rückfrage
app.post("/documents/:id/hold", (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });
  doc.status = "on_hold";
  res.json({ message: "Document put on hold", doc });
});

app.post("/documents/:id/process", async (req, res) => {
    console.log("📥 POST /documents/:id/process wurde aufgerufen");

  const doc = documents[req.params.id];
  if (!doc) {
    console.log("❌ Dokument nicht gefunden:", req.params.id);
    return res.status(404).json({ error: "Dokument nicht gefunden" });
  }

  try {
    const sourcePath = path.join(__dirname, "inbox", doc.filename);
    const destPath = path.join(__dirname, "processing", doc.filename);
    const metaPath = path.join(__dirname, "processing", `${doc.id}.json`);

    console.log("➡️ Verarbeite Dokument:");
    console.log("  📄 Quelle:", sourcePath);
    console.log("  📦 Ziel:", destPath);
    console.log("  🧾 Metadaten-Datei:", metaPath);

    // 1. Datei verschieben
    await fsPromises.rename(sourcePath, destPath);

    // 2. Metadaten-Objekt erstellen
    const metadataToSave = {
      id: doc.id,
      filename: doc.filename,
      status: "processed",
      metadata: doc.metadata,
      confidence: doc.confidence,
      user: doc.user || "unbekannt",
      processedAt: new Date().toISOString(),
    };

    // 3. JSON-Datei schreiben
    await fsPromises.writeFile(metaPath, JSON.stringify(metadataToSave, null, 2), "utf-8");

    // 4. Status im Speicher aktualisieren
    doc.status = "processed";

    res.json({ message: "✅ Dokument verarbeitet", doc: metadataToSave });
  } catch (err) {
    console.error("❌ Fehler beim Verarbeiten:", err.message);
    res.status(500).json({ error: "Fehler beim Verarbeiten", details: err.message });
  }
});



// Login (Mock)
app.post("/login", (req, res) => {
  const { username } = req.body;
  res.json({ message: `Welcome ${username}`, token: "mock-token" });
});

// Logs (Platzhalter)
app.get("/logs/:id", (req, res) => {
  res.json({ id: req.params.id, logs: ["Created", "Classified", "Processed"] });
});

//
// ---- Frontend ausliefern ----
//
app.use(express.static(path.join(__dirname, "frontend")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

//
// ---- Server starten ----
//
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});