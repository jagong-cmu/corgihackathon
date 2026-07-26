/**
 * Sidebar — the left slide-in navigation drawer.
 *
 * Opens from the hamburger control in the shell. Lets you start a new
 * tutoring session, switch/create tutors, and upload lesson materials that
 * ground the tutor's answers.
 *
 * Materials are read/written through the backend API; on a static host (no
 * backend) those calls fail gracefully and the materials list stays empty.
 */
import { useCallback, useEffect, useState } from "react";
import { useTutors } from "../tutors/TutorContext";
import { Avatar } from "./Avatar";
import {
  ingestFiles,
  getMaterials,
  type Material,
  type MaterialsResponse,
} from "../api";
import "./sidebar.css";

const ACCEPT = ".pdf,.docx,.pptx,.txt,.md,.csv";

export function Sidebar() {
  const {
    tutors,
    activeTutor,
    setActiveTutor,
    removeTutor,
    sidebarOpen,
    closeSidebar,
    openCreate,
    newSession,
  } = useTutors();

  const [materials, setMaterials] = useState<Material[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [mergeDetail, setMergeDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const applyResponse = useCallback((res: MaterialsResponse) => {
    setMaterials(res.materials);
    setProvider(res.provider);
    setMergeDetail(res.merge?.detail ?? null);
  }, []);

  // Load existing materials on mount. The backend may be absent (static host);
  // if so we simply leave the list empty.
  useEffect(() => {
    let cancelled = false;
    getMaterials()
      .then((res) => {
        if (!cancelled) applyResponse(res);
      })
      .catch(() => {
        /* no backend — leave list empty */
      });
    return () => {
      cancelled = true;
    };
  }, [applyResponse]);

  // Escape closes the drawer while open.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, closeSidebar]);

  const onUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const list = Array.from(files);
      e.target.value = ""; // allow re-selecting the same file
      setBusy(true);
      setStatus(`Ingesting ${list.length} file${list.length === 1 ? "" : "s"}…`);
      try {
        const res = await ingestFiles(list);
        applyResponse(res);
        setStatus(
          `Added ${list.length} file${list.length === 1 ? "" : "s"} · ${res.corpusSize} in corpus`
        );
      } catch {
        setStatus("Upload failed — no materials backend on this host.");
      } finally {
        setBusy(false);
      }
    },
    [applyResponse]
  );

  if (!sidebarOpen) return null;

  return (
    <div className="sb-root">
      <div
        className="sb-backdrop"
        onClick={closeSidebar}
        aria-hidden="true"
      />
      <aside
        className="sb-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <header className="sb-header">
          <span className="sb-wordmark">Chalk</span>
          <button
            type="button"
            className="sb-close"
            onClick={closeSidebar}
            aria-label="Close menu"
          >
            ×
          </button>
        </header>

        <button
          type="button"
          className="sb-new-session"
          onClick={() => {
            newSession();
            closeSidebar();
          }}
        >
          <span className="sb-plus">＋</span> New tutoring session
        </button>

        <section className="sb-section">
          <h2 className="sb-label">Your tutors</h2>
          <ul className="sb-tutors">
            {tutors.map((t) => {
              const active = t.id === activeTutor.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`sb-tutor${active ? " sb-tutor-active" : ""}`}
                    onClick={() => {
                      setActiveTutor(t.id);
                      closeSidebar();
                    }}
                    aria-pressed={active}
                  >
                    <span className="sb-tutor-face">
                      <Avatar tutor={t} size={38} />
                    </span>
                    <span className="sb-tutor-meta">
                      <span className="sb-tutor-name">{t.name}</span>
                      <span className="sb-tag">
                        {t.id === "trudy" ? "Corgi" : "Custom"}
                      </span>
                    </span>
                    {active && (
                      <span className="sb-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                    {t.kind === "custom" && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="sb-remove"
                        aria-label={`Remove ${t.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTutor(t.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            e.preventDefault();
                            removeTutor(t.id);
                          }
                        }}
                      >
                        ×
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="sb-create"
            onClick={() => {
              openCreate();
              closeSidebar();
            }}
          >
            <span className="sb-plus">＋</span> Create a new tutor
          </button>
        </section>

        <section className="sb-section">
          <h2 className="sb-label">Lesson materials</h2>
          <label className={`sb-upload${busy ? " sb-upload-busy" : ""}`}>
            <input
              type="file"
              multiple
              accept={ACCEPT}
              className="sb-upload-input"
              onChange={onUpload}
              disabled={busy}
            />
            <span className="sb-upload-face">
              <span className="sb-plus">＋</span>
              {busy ? "Uploading…" : "Upload materials"}
            </span>
            <span className="sb-upload-hint">PDF, DOCX, PPTX, TXT, MD, CSV</span>
          </label>

          {status && <p className="sb-status">{status}</p>}

          {materials.length > 0 ? (
            <ul className="sb-materials">
              {materials.map((m) => (
                <li key={m.fileId} className="sb-material">
                  <span className="sb-material-name" title={m.fileName}>
                    {m.fileName}
                  </span>
                  <span className="sb-material-meta">{m.chunks} chunks</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sb-empty">No materials yet.</p>
          )}

          {(provider || mergeDetail) && (
            <p className="sb-note">
              {provider && <span>{provider}</span>}
              {provider && mergeDetail && " · "}
              {mergeDetail}
            </p>
          )}
        </section>

        <footer className="sb-footer">Chalk · your studio</footer>
      </aside>
    </div>
  );
}
