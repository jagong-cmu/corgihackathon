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
    right: 20,
    bottom: 20,
    width: 316,
    zIndex: 9999,
    fontFamily: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
    color: "#2c2620",
  },
  card: {
    background: "#fbf6ec",
    border: "1px solid #e8dcc7",
    borderRadius: 16,
    boxShadow: "0 2px 4px rgba(50,35,15,.10), 0 24px 56px rgba(60,40,15,.22)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "13px 16px",
    background: "linear-gradient(180deg, #fffefb, #f6efe1)",
    borderBottom: "1px solid #eee2cf",
    cursor: "pointer",
    userSelect: "none",
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontWeight: 600,
    fontSize: 13,
    letterSpacing: ".01em",
    color: "#29201a",
  },
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
  const [open, setOpen] = useState(false);
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
    <div style={S.wrap} className="materials-fab">
      <div style={S.card}>
        <div style={S.header} onClick={() => setOpen((o) => !o)}>
          <span style={S.title}>
            <span
              style={{
                display: "inline-grid",
                placeItems: "center",
                width: 22,
                height: 22,
                borderRadius: 7,
                background: "#fbe7cf",
                border: "1px solid #f0d3ac",
                fontSize: 12,
              }}
            >
              📎
            </span>
            Lesson materials
            {materials.length > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#9a4f16",
                  background: "#fbe7cf",
                  border: "1px solid #f0d3ac",
                  borderRadius: 999,
                  padding: "1px 7px",
                }}
              >
                {materials.length}
              </span>
            )}
          </span>
          <span style={{ fontSize: 12, color: "#9c9080" }}>{open ? "▾" : "▸"}</span>
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
