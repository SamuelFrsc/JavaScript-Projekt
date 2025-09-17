// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fsPromises from "fs/promises";

const app = express();
app.use(bodyParser.json());
app.use(cors());

// __dirname nachbauen (weil ES-Module)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Ordner-Konstanten ----
const INBOX_DIR = path.join(__dirname, "inbox");
const PROCESSING_DIR = path.join(__dirname, "processing");
const DELETED_DIR = path.join(__dirname, "deleted");

// ---- In-Memory Store für Dokumente ----
let documents = {};

// Hilfsfunktion: ID aus Dateinamen erzeugen
const makeIdFromFilename = (file) =>
  file.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_\-]/g, "_");

// ---- Initialisierung: Inbox scannen ----
const initFromInbox = async () => {
  console.log("📥 initFromInbox gestartet...");

  try {
    const inboxFiles = await fsPromises.readdir(INBOX_DIR);
    console.log("📁 Gefundene Dateien:", inboxFiles);

    inboxFiles.forEach((file) => {
      if (file.toLowerCase().endsWith(".pdf")) {
        const id = makeIdFromFilename(file);

        if (!documents[id]) {
          documents[id] = {
            id,
            filename: file,
            status: "inbox",
            metadata: {},
            confidence: null,
            user: "system",
          };
          console.log(`✅ Dokument hinzugefügt: ${file} → id=${id}`);
        }
      }
    });

    // Entferne Dokumente aus dem Speicher, die nicht mehr in inbox liegen
    Object.keys(documents).forEach((id) => {
      const file = documents[id].filename;
      if (!inboxFiles.includes(file) && documents[id].status === "inbox") {
        console.log(`🗑️ Entferne ${file} aus documents (nicht mehr im Ordner).`);
        delete documents[id];
      }
    });
  } catch (err) {
    console.error("❌ Fehler beim Einlesen der Inbox:", err.message);
  }
};

// ---- Beim Start einmal scannen + alle 5 Sekunden erneut ----
initFromInbox();
setInterval(initFromInbox, 5000);

// ---- API-Routen ----

// Alle Dokumente zurückgeben
app.get("/documents", (req, res) => {
  res.json(Object.values(documents));
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
  const id = makeIdFromFilename(filename);

  documents[id] = {
    id,
    filename,
    status: "inbox",
    metadata: {},
    confidence: null,
    user: user || "manual",
  };

  res.status(201).json(documents[id]);
});

// Dokument aktualisieren (Metadaten ändern)
app.put("/documents/:id", (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  documents[req.params.id] = { ...doc, ...req.body };
  res.json(documents[req.params.id]);
});

// Dokument zur Löschung markieren
app.delete("/documents/:id", (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  doc.status = "deleted";
  res.json({ message: "Document marked for deletion", doc });
});

// Klassifizieren (Fake-Logik)
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

// Re-Klassifizieren
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

// Dokument verarbeiten (verschieben + Metadaten speichern)
app.post("/documents/:id/process", async (req, res) => {
  const doc = documents[req.params.id];
  if (!doc) return res.status(404).json({ error: "Not found" });

  try {
    const sourcePath = path.join(INBOX_DIR, doc.filename);
    const destPath = path.join(PROCESSING_DIR, doc.filename);
    const metaPath = path.join(PROCESSING_DIR, `${doc.id}.json`);

    // 1. Datei verschieben
    await fsPromises.rename(sourcePath, destPath);

    // 2. Metadaten speichern
    const metadataToSave = {
      id: doc.id,
      filename: doc.filename,
      status: "processed",
      metadata: doc.metadata,
      confidence: doc.confidence,
      user: doc.user || "unbekannt",
      processedAt: new Date().toISOString(),
    };

    await fsPromises.writeFile(metaPath, JSON.stringify(metadataToSave, null, 2), "utf-8");

    // 3. Status im Speicher aktualisieren
    doc.status = "processed";

    res.json({ message: "✅ Dokument verarbeitet", doc: metadataToSave });
  } catch (err) {
    console.error("❌ Fehler beim Verarbeiten:", err.message);
    res.status(500).json({ error: "Fehler beim Verarbeiten", details: err.message });
  }
});

// ---- Login (Mock) ----
app.post("/login", (req, res) => {
  const { username } = req.body;
  res.json({ message: `Welcome ${username}`, token: "mock-token" });
});

// ---- Logs (Platzhalter) ----
app.get("/logs/:id", (req, res) => {
  res.json({ id: req.params.id, logs: ["Created", "Classified", "Processed"] });
});

// ---- Frontend ausliefern ----
app.use(express.static(path.join(__dirname, "frontend")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

// ---- Server starten ----
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});
