/**
 * MaterialsPanel — a self-contained RAG upload widget (Phase 3 test affordance).
 *
 * Deliberately standalone: fixed-position overlay with fully INLINE styles so
 * it never collides with the Chalk redesign in index.css and needs no changes
 * to TutorShell. Upload docs here → they're ingested (extract → chunk → embed →
 * store) → the tutor's answers get grounded in them automatically.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ingestFiles, getMaterials, type Material } from "../api";

const S: Record<string, React.CSSProperties> = {
  wrap: {
    position: "fixed",
    right: 18,
    bottom: 18,
    width: 320,
    zIndex: 9999,
    fontFamily: 'ui-sans-serif, system-ui, "Space Grotesk", sans-serif',
    color: "#2c2723",
  },
  card: {
    background: "#fbf7ef",
    border: "1px solid #e7ddcc",
    borderRadius: 14,
    boxShadow: "0 2px 4px rgba(60,45,25,.08), 0 18px 44px rgba(70,50,20,.18)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "11px 14px",
    background: "#f3ead9",
    borderBottom: "1px solid #e7ddcc",
    cursor: "pointer",
    userSelect: "none",
  },
  title: { fontWeight: 700, fontSize: 13, letterSpacing: ".01em" },
  body: { padding: 14, display: "flex", flexDirection: "column", gap: 10 },
  uploadBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "11px 14px",
    borderRadius: 11,
    border: "1px dashed #d8b483",
    background: "#fdf6ea",
    color: "#a2551a",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    textAlign: "center",
  },
  note: { fontSize: 11, color: "#9a8f80", lineHeight: 1.4 },
  list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
  item: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 12,
    padding: "7px 10px",
    background: "#fff",
    border: "1px solid #efe7d7",
    borderRadius: 9,
  },
  itemName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chunks: { color: "#9a8f80", flex: "none" },
  status: { fontSize: 12, minHeight: 16 },
  pill: {
    fontSize: 10,
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: 999,
    background: "#fbe9d3",
    color: "#c46a22",
    border: "1px solid #f0d3ac",
  },
};

export function MaterialsPanel() {
  const [open, setOpen] = useState(true);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [mergeDetail, setMergeDetail] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await getMaterials();
      setMaterials(r.materials);
      setProvider(r.provider);
      setMergeDetail(r.merge?.detail ?? "");
    } catch {
      /* backend absent (static host) — leave empty */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      setBusy(true);
      setStatus(`Ingesting ${files.length} file(s)…`);
      try {
        const r = await ingestFiles(files);
        setMaterials(r.materials);
        setProvider(r.provider);
        setStatus(`Ingested. ${r.corpusSize} chunk(s) indexed — ask a question to see grounding.`);
      } catch (e) {
        setStatus(`⚠ ${(e as Error).message}`);
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    []
  );

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.header} onClick={() => setOpen((o) => !o)}>
          <span style={S.title}>📄 Materials — ground answers (RAG)</span>
          <span style={{ fontSize: 12, color: "#9a8f80" }}>{open ? "▾" : "▸"}</span>
        </div>

        {open && (
          <div style={S.body}>
            <label style={S.uploadBtn}>
              {busy ? "Working…" : "＋ Upload PDF / DOCX / PPTX / TXT"}
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".pdf,.docx,.pptx,.txt,.md,.markdown,.csv,application/pdf"
                style={{ display: "none" }}
                disabled={busy}
                onChange={(e) => void onFiles(e.target.files)}
              />
            </label>

            {status && <div style={S.status}>{status}</div>}

            {materials.length > 0 ? (
              <ul style={S.list}>
                {materials.map((m) => (
                  <li key={m.fileId} style={S.item}>
                    <span style={S.itemName}>{m.fileName}</span>
                    <span style={S.chunks}>{m.chunks} chunk{m.chunks === 1 ? "" : "s"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div style={S.note}>
                No materials yet. Upload a document, then ask the tutor about it — the
                answer will be grounded in what you uploaded.
              </div>
            )}

            <div style={S.note}>
              {provider && (
                <>
                  embeddings: <span style={S.pill}>{provider}</span>
                  <br />
                </>
              )}
              {mergeDetail || "Local upload path (Merge not connected)."}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
