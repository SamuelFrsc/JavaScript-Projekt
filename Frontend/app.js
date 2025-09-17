const API_URL = "http://localhost:3000";

// DOM-Elemente
const inboxTable = document.getElementById("inboxTable");
const refreshBtn = document.getElementById("refreshBtn");
const detailView = document.getElementById("detailView");
const docDetails = document.getElementById("docDetails");
const closeDetail = document.getElementById("closeDetail");

// Dokumente laden
async function loadDocuments() {
  console.log("⏳ Lade Dokumente vom Backend...");

  const res = await fetch(`${API_URL}/documents`);
  const docs = await res.json();

  console.log("📄 Geladene Dokumente:", docs);

  inboxTable.innerHTML = "";
  docs.forEach(doc => {
    const tr = document.createElement("tr");

    tr.innerHTML = `
  <td><input type="checkbox" class="rowCheckbox" value="${doc.id}"></td>
  <td>${doc.filename || "-"}</td>
  <td>${doc.status || "-"}</td>
  <td>${doc.metadata?.category || doc.doc_subject_val || "-"}</td>
  <td>${doc.confidence ?? doc.doc_id_score ?? "-"}</td>
  <td>
    <button onclick="showDetail('${doc.id}')">👁️</button>
    <button onclick="classifyDoc('${doc.id}')">🤖 Klassifizieren</button>
    <button onclick="processDoc('${doc.id}')">✅ Verarbeiten</button>
    <button onclick="deleteDoc('${doc.id}')">🗑️ Löschen</button>
  </td>
`;


    inboxTable.appendChild(tr);
  });
}

// Dokument klassifizieren
async function classifyDoc(id) {
  await fetch(`${API_URL}/documents/${id}/classify`, { method: "POST" });
  loadDocuments();
}

// Dokument verarbeiten
async function processDoc(id) {
  await fetch(`${API_URL}/documents/${id}/process`, { method: "POST" });
  loadDocuments();
}

// Dokument löschen
async function deleteDoc(id) {
  await fetch(`${API_URL}/documents/${id}`, { method: "DELETE" });
  loadDocuments();
}

// Detailansicht anzeigen
async function showDetail(id) {
  const res = await fetch(`${API_URL}/documents/${id}`);
  const doc = await res.json();

  docDetails.innerHTML = `
  <p><b>Datei:</b> ${doc.filename}</p>
  <p><b>Status:</b> ${doc.status}</p>

  <label>Kategorie:
    <select id="editCategory">
      <option value="Rechnung">Rechnung</option>
      <option value="Kontoauszug">Kontoauszug</option>
      <option value="Sonstiges">Sonstiges</option>
    </select>
  </label>
  <br><br>

  <label>Confidence:
    <input type="number" id="editConfidence" min="0" max="1" step="0.01" value="${doc.confidence ?? ''}">
  </label>
  <br><br>

  <button id="saveMetadata">💾 Speichern</button>
`;

  document.getElementById("editCategory").value = doc.metadata?.category || "Sonstiges";

  // Save-Button Event
  document.getElementById("saveMetadata").onclick = async () => {
    const newCategory = document.getElementById("editCategory").value;
    const newConfidence = parseFloat(document.getElementById("editConfidence").value);

    await fetch(`${API_URL}/documents/${doc.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metadata: { category: newCategory },
        confidence: newConfidence,
      }),
    });

    alert("✅ Änderungen gespeichert");
    detailView.classList.add("hidden");
    loadDocuments();
  };

  detailView.classList.remove("hidden");
}

// Detailansicht schließen
closeDetail.addEventListener("click", () => {
  detailView.classList.add("hidden");
});

// Event-Listener
refreshBtn.addEventListener("click", loadDocuments);

// Initial laden
loadDocuments();

// Exporte für globale Sichtbarkeit im Browser
window.showDetail = showDetail;
window.processDoc = processDoc;
window.classifyDoc = classifyDoc;
window.deleteDoc = deleteDoc;

// Optional: Automatische Aktualisierung alle 5 Sekunden

// Upload-Button
document.getElementById("uploadBtn").addEventListener("click", () => {
  document.getElementById("uploadInput").click();
});

document.getElementById("uploadInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    const formData = new FormData();
    formData.append("pdf", file);

    const res = await fetch(`${API_URL}/upload`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      console.log(`✅ Hochgeladen: ${file.name}`);
    } else {
      alert(`❌ Fehler beim Hochladen: ${file.name}`);
    }
  }
  loadDocuments();
});

// Checkboxen
document.getElementById("selectAll").addEventListener("change", (e) => {
  document.querySelectorAll(".rowCheckbox").forEach(cb => cb.checked = e.target.checked);
});

function getSelectedIds() {
  return Array.from(document.querySelectorAll(".rowCheckbox:checked")).map(cb => cb.value);
}

// Mehrfachaktionen
document.getElementById("multiProcess").addEventListener("click", async () => {
  for (const id of getSelectedIds()) {
    await fetch(`${API_URL}/documents/${id}/process`, { method: "POST" });
  }
  loadDocuments();
});

document.getElementById("multiClassify").addEventListener("click", async () => {
  for (const id of getSelectedIds()) {
    await fetch(`${API_URL}/documents/${id}/classify`, { method: "POST" });
  }
  loadDocuments();
});

document.getElementById("multiDelete").addEventListener("click", async () => {
  for (const id of getSelectedIds()) {
    await fetch(`${API_URL}/documents/${id}`, { method: "DELETE" });
  }
  loadDocuments();
});

