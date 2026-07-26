/**
 * MaterialsPanel — upload documents the tutor should teach from.
 *
 * Uploads go to the API's ingestion path (extract → chunk → embed → pgvector),
 * the same index the worker queries in-loop. There is no second retrieval stack
 * in the browser and no client-side embedding: what the panel lists is exactly
 * what the tutor can retrieve.
 *
 * Materials are per-learner, so the panel is inert until a session exists —
 * that is where the learner id comes from. Styles stay inline and
 * fixed-position so this widget never collides with the board's layout.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteMaterial,
  listMaterials,
  uploadMaterial,
  type Material,
  type RetrievalStatus,
} from "../api";

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
  disabledBtn: { opacity: 0.55, cursor: "not-allowed" },
  note: { fontSize: 11, color: "#9a8f80", lineHeight: 1.4 },
  list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 12,
    padding: "7px 10px",
    background: "#fff",
    border: "1px solid #efe7d7",
    borderRadius: 9,
  },
  itemName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  chunks: { color: "#9a8f80", flex: "none" },
  remove: {
    border: "none",
    background: "transparent",
    color: "#b0796a",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    padding: 2,
    flex: "none",
  },
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

interface Props {
  /** Null until a lesson starts. Materials are scoped to a learner. */
  userId: string | null;
}

export function MaterialsPanel({ userId }: Props) {
  const [open, setOpen] = useState(true);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [retrieval, setRetrieval] = useState<RetrievalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const result = await listMaterials(userId);
      setMaterials(result.materials);
      setRetrieval(result.retrieval);
    } catch (err) {
      setStatus(`⚠ ${(err as Error).message}`);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList?.length || !userId) return;
      const files = Array.from(fileList);
      setBusy(true);
      try {
        let indexed = 0;
        for (const file of files) {
          // Sequential rather than parallel: each upload embeds its chunks, and
          // a dozen concurrent embed calls is how you rate-limit yourself.
          setStatus(`Indexing ${file.name}…`);
          const material = await uploadMaterial(userId, file);
          indexed += material.chunks;
        }
        await refresh();
        setStatus(`Indexed ${indexed} chunk(s). Ask the tutor about them.`);
      } catch (err) {
        setStatus(`⚠ ${(err as Error).message}`);
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [userId, refresh],
  );

  const onRemove = useCallback(
    async (material: Material) => {
      if (!userId) return;
      setBusy(true);
      try {
        await deleteMaterial(userId, material.uploadId);
        await refresh();
        setStatus(`Removed ${material.filename}.`);
      } catch (err) {
        setStatus(`⚠ ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [userId, refresh],
  );

  const disabled = !userId || busy || retrieval?.available === false;

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.header} onClick={() => setOpen((o) => !o)}>
          <span style={S.title}>📄 Materials — what the tutor can teach from</span>
          <span style={{ fontSize: 12, color: "#9a8f80" }}>{open ? "▾" : "▸"}</span>
        </div>

        {open && (
          <div style={S.body}>
            <label style={{ ...S.uploadBtn, ...(disabled ? S.disabledBtn : {}) }}>
              {busy ? "Working…" : "＋ Upload PDF / DOCX / PPTX / TXT"}
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".pdf,.docx,.pptx,.txt,.md,.markdown,.csv"
                style={{ display: "none" }}
                disabled={disabled}
                onChange={(e) => void onFiles(e.target.files)}
              />
            </label>

            {status && <div style={S.status}>{status}</div>}

            {materials.length > 0 ? (
              <ul style={S.list}>
                {materials.map((m) => (
                  <li key={m.uploadId} style={S.item}>
                    <span style={S.itemName} title={m.filename}>
                      {m.filename}
                    </span>
                    <span style={S.chunks}>{m.chunks}</span>
                    <button
                      style={S.remove}
                      title={`Remove ${m.filename} and everything indexed from it`}
                      disabled={busy}
                      onClick={() => void onRemove(m)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div style={S.note}>
                {!userId
                  ? "Start a lesson first — materials are saved per learner."
                  : retrieval?.available === false
                    ? retrieval.detail
                    : "No materials yet. Upload a document, then ask the tutor about it."}
              </div>
            )}

            {retrieval?.embeddings && retrieval.available && (
              <div style={S.note}>
                embeddings: <span style={S.pill}>{retrieval.embeddings}</span>
                {retrieval.embeddings === "hashing" && (
                  <>
                    <br />
                    Keyword-ish, not semantic. Set VOYAGE_API_KEY for real retrieval.
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
