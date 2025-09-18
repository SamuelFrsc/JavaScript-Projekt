// app.js
// Frontend-Client für den BFF

// Wenn Frontend und BFF auf dem selben Origin laufen, leer lassen:
const API_URL = ""; // z.B. "", sonst "http://localhost:3000"
let currentViewIds = [];
const nextDetailBtn = document.getElementById("nextDetailBtn");

const profileSelect = document.getElementById("profileSelect");


const CURRENT_USER = "backoffice-demo";
const commonHeaders = { "X-User": CURRENT_USER };
const metadataJson = document.getElementById("metadataJson");

const rowsEl = document.getElementById("rows");
const selectAllEl = document.getElementById("selectAll");
const statusFilterEl = document.getElementById("statusFilter");

const detailModal = document.getElementById("detailModal");
const closeDetailBtn = document.getElementById("closeDetail");
const detailTitle = document.getElementById("detailTitle");
const pdfLinkWrap = document.getElementById("pdfLinkWrap");

const editCategory = document.getElementById("editCategory");
const editDocId = document.getElementById("editDocId");
const editSubject = document.getElementById("editSubject");
const editDocDate = document.getElementById("editDocDate");
const editConfidence = document.getElementById("editConfidence");

const saveMetadataBtn = document.getElementById("saveMetadata");
const processNowBtn = document.getElementById("processNow");
const openNextAfterSave = document.getElementById("openNextAfterSave");

let currentDoc = null;

// ---------------------------
// UI Helpers
// ---------------------------
function linkForDoc(doc) {
  // je nach Status richtigen Ordner linken
  const map = {
    inbox: "inbox",
    processing: "processing",
    hold: "hold",
    processed: "processing",
    deleted: null, // nicht anzeigen
    needs_review: "needs-review",
  };
  const base = map[doc.status] || "inbox";
  if (!base) return null;
  return `${API_URL}/${base}/${encodeURIComponent(doc.fileName)}`;
}

function fmtConf(conf) {
  return typeof conf === "number" ? conf.toFixed(2) : "-";
}

function renderRows(list) {
  currentViewIds = list.map(d => d.id);  // <- Reihenfolge sichern
  rowsEl.innerHTML = "";
  list.forEach((doc) => {
    const tr = document.createElement("tr");

    const cbTd = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "rowCheckbox";
    cb.dataset.id = doc.id;
    cbTd.appendChild(cb);

    const fileTd = document.createElement("td");
    const a = document.createElement("a");
    const url = linkForDoc(doc);
    a.textContent = doc.fileName;
    if (url) {
      a.href = url; a.target = "_blank"; a.rel = "noreferrer";
    } else {
      a.href = "javascript:void(0)";
    }
    fileTd.appendChild(a);

    const statusTd = document.createElement("td");
    statusTd.textContent = doc.status;

    const confTd = document.createElement("td");
    confTd.textContent = fmtConf(doc.confidence);

    const catTd = document.createElement("td");
    catTd.textContent = doc.category || "-";


    const actionsTd = document.createElement("td");
    actionsTd.className = "actions";
    actionsTd.innerHTML = `
      <button data-act="view" data-id="${doc.id}">🔍 Details</button>
      <button data-act="classify" data-id="${doc.id}">🤖 Klassifizieren</button>
      <button data-act="reclassify" data-id="${doc.id}">♻️ Re-klassifizieren</button>
      <button data-act="process" data-id="${doc.id}">✅ Verarbeiten</button>
      <button data-act="hold" data-id="${doc.id}">⏸️ Hold</button>
      <button data-act="delete" data-id="${doc.id}">🗑️ Löschen</button>
    `;

    tr.appendChild(cbTd);
    tr.appendChild(fileTd);
    tr.appendChild(statusTd);
    tr.appendChild(confTd);
    tr.appendChild(catTd);
    tr.appendChild(actionsTd);
    rowsEl.appendChild(tr);
  });
}

async function loadDocuments() {
  const status = statusFilterEl.value ? `?status=${encodeURIComponent(statusFilterEl.value)}` : "";
  const res = await fetch(`/api/classify/sync-now${status}`);
  const data = await res.json();
  renderRows(data.documents);
}

async function openNext(status = "needs_review") {
  const res = await fetch(`${API_URL}/documents/next?status=${encodeURIComponent(status)}`);
  if (!res.ok) {
    alert("Kein Dokument im gewünschten Status.");
    return;
  }
  const doc = await res.json();
  openDetail(doc.id);
}

// ---------------------------
// Detail-View
// ---------------------------
async function openDetail(id) {
  const res = await fetch(`${API_URL}/documents/${id}`);
  if (!res.ok) return alert("Dokument nicht gefunden");
  const doc = await res.json();
  currentDoc = doc;
  detailTitle.textContent = `Details – ${doc.filename}`;
  const url = linkForDoc(doc);
  pdfLinkWrap.innerHTML = url ? `<a href="${url}" target="_blank" rel="noreferrer">PDF öffnen</a>` : "<i>Keine Vorschau</i>";
  editCategory.value = doc.metadata?.category || "";
  editDocId.value = doc.metadata?.docId || "";
  editSubject.value = doc.metadata?.subject || "";
  editDocDate.value = doc.metadata?.docDate || "";
  editConfidence.value = typeof doc.confidence === "number" ? String(doc.confidence) : "";
  detailModal.classList.remove("hidden");

  metadataJson.value = JSON.stringify(doc.metadata || {}, null, 2);

if (doc.status === "processed") {
  metadataJson.removeAttribute("readonly");
} else {
  metadataJson.setAttribute("readonly", "true");
}

}

async function saveCurrentMeta() {
  if (!currentDoc) return;

  // 1) Werte aus den Eingabefeldern
  let newMeta = {
    category: editCategory.value || undefined,
    docId: editDocId.value || undefined,
    subject: editSubject.value || undefined,
    docDate: editDocDate.value || undefined,
  };

  // 2) Wenn processed → JSON dazu mergen (Inputs haben Vorrang!)
  if (currentDoc.status === "processed") {
    try {
      const parsedJson = JSON.parse(metadataJson.value);
      newMeta = { ...parsedJson, ...newMeta };
    } catch (e) {
      alert("❌ Ungültiges JSON: " + e.message);
      return;
    }
  }
  async function processCurrentNow() {
  if (!currentDoc) return;
  try {
    const res = await fetch(`${API_URL}/documents/${currentDoc.id}/process`, {
      method: "POST",
      headers: commonHeaders,
    });
    if (!res.ok) {
      alert("Verarbeiten fehlgeschlagen");
      return;
    }
    await loadDocuments();

    if (openNextAfterSave.checked) {
      detailModal.classList.add("hidden");
      openNext("needs_review");
    } else {
      detailModal.classList.add("hidden");
    }
  } catch (e) {
    alert("Fehler beim Verarbeiten: " + e.message);
  }
}


  // 🔹 3) PROFIL -> nutzer setzen (nach dem Merge, damit es sicher gewinnt)
  const selectedProfileText =
    profileSelect
      ? profileSelect.options[profileSelect.selectedIndex].text  // "Profil 1", ...
      : "Profil 1"; // Fallback
  newMeta.nutzer = selectedProfileText;

  // 4) Payload bauen
  const payload = {
    metadata: newMeta,
    confidence: editConfidence.value ? parseFloat(editConfidence.value) : undefined,
    mode: "corrected",
  };

  // 5) PUT an Backend
  await fetch(`${API_URL}/documents/${currentDoc.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...commonHeaders },
    body: JSON.stringify(payload),
  });

  // 6) UI aktualisieren
  await loadDocuments();
  if (openNextAfterSave.checked) {
    detailModal.classList.add("hidden");
    openNext("needs_review");
  } else {
    detailModal.classList.add("hidden");
  }
}



// ---------------------------
// Aktionen
// ---------------------------
document.getElementById("uploadBtn").addEventListener("click", () => {
  document.getElementById("uploadInput").click();
});

document.getElementById("uploadInput").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const formData = new FormData();
    formData.append("pdf", file);
    const res = await fetch(`${API_URL}/upload`, { method: "POST", body: formData, headers: { "X-User": CURRENT_USER } });
    if (!res.ok) console.error("Upload Fehler:", await res.text());
  }
  await loadDocuments();
  e.target.value = "";
});

document.getElementById("refreshBtn").addEventListener("click", loadDocuments);

statusFilterEl.addEventListener("change", loadDocuments);

selectAllEl.addEventListener("change", (e) => {
  document.querySelectorAll(".rowCheckbox").forEach((cb) => (cb.checked = e.target.checked));
});

// Delegation für Tabellenaktionen
rowsEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  if (act === "view") {
    openDetail(id);
  } else if (act === "classify") {
    await fetch(`${API_URL}/documents/${id}/classify`, { method: "POST", headers: commonHeaders });
    await loadDocuments();
  } else if (act === "reclassify") {
    await fetch(`${API_URL}/documents/${id}/reclassify`, { method: "POST", headers: commonHeaders });
    await loadDocuments();
  } else if (act === "process") {
    await fetch(`${API_URL}/documents/${id}/process`, { method: "POST", headers: commonHeaders });
    await loadDocuments();
  } else if (act === "hold") {
    await fetch(`${API_URL}/documents/${id}/hold`, { method: "POST", headers: commonHeaders });
    await loadDocuments();
  } else if (act === "delete") {
    if (confirm("Dokument in 'deleted' verschieben?")) {
      await fetch(`${API_URL}/documents/${id}/delete`, { method: "POST", headers: commonHeaders });
      await loadDocuments();
    }
  }
});

function getSelectedIds() {
  return Array.from(document.querySelectorAll(".rowCheckbox:checked"))
    .map(cb => cb.dataset.id);
}

document.getElementById("bulkProcess").addEventListener("click", async () => {
  const ids = getSelectedIds();
  if (!ids.length) return alert("Keine Dokumente ausgewählt.");
  for (const id of ids) {
    await fetch(`${API_URL}/documents/${id}/process`, { method: "POST", headers: commonHeaders });
  }
  await loadDocuments();
});

document.getElementById("bulkHold").addEventListener("click", async () => {
  const ids = getSelectedIds();
  if (!ids.length) return alert("Keine Dokumente ausgewählt.");
  for (const id of ids) {
    await fetch(`${API_URL}/documents/${id}/hold`, { method: "POST", headers: commonHeaders });
  }
  await loadDocuments();
});

document.getElementById("bulkDelete").addEventListener("click", async () => {
  const ids = getSelectedIds();
  if (!ids.length) return alert("Keine Dokumente ausgewählt.");
  if (!confirm("Ausgewählte Dokumente wirklich in 'deleted' verschieben?")) return;
  for (const id of ids) {
    await fetch(`${API_URL}/documents/${id}/delete`, { method: "POST", headers: commonHeaders });
  }
  await loadDocuments();
});

// Detail-Modal Steuerung

function getIndexInCurrentView() {
  if (!currentDoc) return -1;

  // 1) Primär: gespeicherte Reihenfolge aus renderRows
  let idx = currentViewIds.indexOf(currentDoc.id);

  // 2) Fallback: Reihenfolge live aus dem DOM lesen
  if (idx === -1) {
    const idsFromDom = Array.from(document.querySelectorAll(".rowCheckbox"))
      .map(cb => cb.dataset.id);
    currentViewIds = idsFromDom;
    idx = currentViewIds.indexOf(currentDoc.id);
  }
  return idx;
}

function openNextInCurrentView() {
  const idx = getIndexInCurrentView();
  if (idx >= 0 && idx < currentViewIds.length - 1) {
    const nextId = currentViewIds[idx + 1];
    detailModal.classList.add("hidden");   // aktuelle schließen
    openDetail(nextId);                    // nächste öffnen
  } else {
    alert("Kein weiteres Dokument in der aktuellen Liste.");
  }
}

nextDetailBtn?.addEventListener("click", openNextInCurrentView);


// Detail-Modal Steuerung
closeDetailBtn.addEventListener("click", () => detailModal.classList.add("hidden"));
saveMetadataBtn.addEventListener("click", saveCurrentMeta);

// Initial
loadDocuments();