/**
 * TutorsPanel — create and manage custom tutors.
 *
 * A drawer over the persona API (apps/api): list the tutor library, author a
 * new synthetic tutor (identity + teaching style + speech habits + few-shot
 * exchanges), give it a voice (pick from the ElevenLabs library or clone from
 * a sample), and point it at an avatar (Simli face / LemonSlice agent or a
 * public photo URL).
 *
 * Synthetic tutors only, on purpose: they're the one persona kind the schema
 * allows in the ownerless library (self/real_person require an owner and a
 * consent flow neither of which exists yet — see PersonaSpec §9).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  assignVoice,
  cloneVoice,
  createTutor,
  deleteTutor,
  listTutors,
  listVoices,
  patchTutor,
  slugify,
  tutorApiAvailable,
  voiceCapabilities,
  type TutorExchange,
  type TutorSpec,
  type VoiceCapabilities,
  type VoiceOption,
} from "../tutorApi";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after any successful create/update/delete so pickers can refresh. */
  onChanged: () => void;
}

const STYLES = [
  ["socratic", "Socratic — answers with questions"],
  ["direct", "Direct — states it, then explains"],
  ["worked_example", "Worked example — shows, then hands over"],
  ["story", "Story — narrative first, formal second"],
] as const;

const LEVELS = ["low", "medium", "high"] as const;
const VERBOSITY = ["terse", "medium", "expansive"] as const;

export function TutorsPanel({ open, onClose, onChanged }: Props) {
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [tutors, setTutors] = useState<TutorSpec[]>([]);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [caps, setCaps] = useState<VoiceCapabilities | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshTutors = useCallback(async () => {
    try {
      setTutors(await listTutors());
    } catch (err) {
      setNotice(`could not list tutors: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const up = await tutorApiAvailable();
      if (cancelled) return;
      setApiUp(up);
      if (!up) return;
      void refreshTutors();
      // Voice data is best-effort: the library needs an ElevenLabs key on the
      // API side; tutors can still be authored without it.
      listVoices().then((v) => !cancelled && setVoices(v)).catch(() => {});
      voiceCapabilities().then((c) => !cancelled && setCaps(c)).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [open, refreshTutors]);

  const changed = useCallback(() => {
    void refreshTutors();
    onChanged();
  }, [refreshTutors, onChanged]);

  if (!open) return null;

  return (
    <div className="tutors-overlay" onClick={onClose}>
      <aside
        className="tutors-panel"
        aria-label="Your tutors"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tutors-head">
          <div>
            <div className="tutors-title">Your tutors</div>
            <div className="tutors-sub">
              Design a tutor, give it a voice and a face, then start a session.
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            Close
          </button>
        </header>

        {apiUp === false && (
          <div className="live-warn tutors-block">
            The persona API isn't running. Start Postgres and the API (see
            LIVE_TUTOR.md), then reopen this panel. Built-in tutors still work
            for live sessions.
          </div>
        )}
        {notice && <div className="live-warn tutors-block">⚠ {notice}</div>}

        {apiUp && (
          <>
            <section className="tutors-block">
              <h3 className="tutors-h3">Library</h3>
              {tutors.length === 0 && (
                <p className="tutors-empty">
                  No tutors yet — create the first one below. (Seed the curated
                  library with <code>infra/scripts/seed.py</code>.)
                </p>
              )}
              {tutors.map((t) => (
                <TutorRow
                  key={t.id}
                  tutor={t}
                  voices={voices}
                  caps={caps}
                  onChanged={changed}
                  onError={setNotice}
                />
              ))}
            </section>

            <CreateTutorForm onCreated={changed} onError={setNotice} />
          </>
        )}
      </aside>
    </div>
  );
}

/* ----------------------------------------------------------- tutor rows */

function TutorRow({
  tutor,
  voices,
  caps,
  onChanged,
  onError,
}: {
  tutor: TutorSpec;
  voices: VoiceOption[] | null;
  caps: VoiceCapabilities | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [openEditor, setOpenEditor] = useState<"voice" | "avatar" | null>(null);

  const remove = async () => {
    if (!window.confirm(`Delete tutor “${tutor.identity.name}”?`)) return;
    try {
      await deleteTutor(tutor.id);
      onChanged();
    } catch (err) {
      onError(`delete failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="tutor-row">
      <div className="tutor-row-main">
        <div>
          <span className="tutor-row-name">{tutor.identity.name}</span>
          <span className="tutor-row-id">{tutor.id}</span>
        </div>
        <div className="tutor-row-badges">
          <span className={`tutor-badge ${tutor.voice?.voice_id ? "ok" : "todo"}`}>
            {tutor.voice?.voice_id ? "voice ✓" : "needs a voice"}
          </span>
          <span className={`tutor-badge ${tutor.avatar.provider !== "none" && tutor.avatar.avatar_ref ? "ok" : ""}`}>
            {tutor.avatar.provider !== "none" && tutor.avatar.avatar_ref
              ? `avatar · ${tutor.avatar.provider}`
              : "voice-only"}
          </span>
        </div>
        <div className="tutor-row-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setOpenEditor(openEditor === "voice" ? null : "voice")}
          >
            Voice
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setOpenEditor(openEditor === "avatar" ? null : "avatar")}
          >
            Avatar
          </button>
          <button type="button" className="icon-btn live-end" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>

      {openEditor === "voice" && (
        <VoiceEditor tutor={tutor} voices={voices} caps={caps} onChanged={onChanged} onError={onError} />
      )}
      {openEditor === "avatar" && (
        <AvatarEditor tutor={tutor} onChanged={onChanged} onError={onError} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- voice */

function VoiceEditor({
  tutor,
  voices,
  caps,
  onChanged,
  onError,
}: {
  tutor: TutorSpec;
  voices: VoiceOption[] | null;
  caps: VoiceCapabilities | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [voiceId, setVoiceId] = useState(tutor.voice?.voice_id ?? "");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);

  const preview = (url?: string | null) => {
    if (!url) return;
    previewRef.current?.pause();
    previewRef.current = new Audio(url);
    void previewRef.current.play();
  };
  // Stop a running preview when the editor unmounts.
  useEffect(() => () => previewRef.current?.pause(), []);

  const selected = voices?.find((v) => v.voice_id === voiceId);

  const pick = async () => {
    if (!voiceId) return;
    setBusy(true);
    try {
      await assignVoice(tutor.id, voiceId);
      onChanged();
    } catch (err) {
      onError(`voice assign failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const clone = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await cloneVoice(tutor.id, file);
      onChanged();
    } catch (err) {
      onError(`voice clone failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (voices === null) {
    return (
      <div className="tutor-editor">
        Voice library unavailable — the API needs ELEVENLABS_API_KEY to list and
        clone voices.
      </div>
    );
  }

  const canClone = caps?.can_clone_instant && (caps?.slots_remaining ?? 0) > 0;

  return (
    <div className="tutor-editor">
      <label className="tutors-label">
        Pick from the library
        <div className="tutor-editor-row">
          <select
            className="live-select"
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
          >
            <option value="">— choose a voice —</option>
            {voices.map((v) => (
              <option key={v.voice_id} value={v.voice_id}>
                {v.name}
                {v.category ? ` (${v.category})` : ""}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-btn"
            disabled={!selected?.preview_url}
            onClick={() => preview(selected?.preview_url)}
          >
            Preview
          </button>
          <button type="button" className="ask-btn" disabled={!voiceId || busy} onClick={() => void pick()}>
            Assign
          </button>
        </div>
      </label>

      <label className="tutors-label">
        …or clone from a sample (1–2 min of clear speech)
        <div className="tutor-editor-row">
          <input ref={fileRef} type="file" accept="audio/*" disabled={!canClone} />
          <button type="button" className="ask-btn" disabled={!canClone || busy} onClick={() => void clone()}>
            Clone
          </button>
        </div>
        {!canClone && (
          <span className="tutors-hint">
            {caps
              ? "Cloning isn't available on the current ElevenLabs plan."
              : "Checking plan capabilities…"}
          </span>
        )}
      </label>
    </div>
  );
}

/* -------------------------------------------------------------- avatar */

function AvatarEditor({
  tutor,
  onChanged,
  onError,
}: {
  tutor: TutorSpec;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [provider, setProvider] = useState(tutor.avatar.provider ?? "none");
  const [ref, setRef] = useState(tutor.avatar.avatar_ref ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await patchTutor(tutor.id, {
        avatar: { provider, avatar_ref: provider === "none" ? null : ref || null },
      });
      onChanged();
    } catch (err) {
      onError(`avatar update failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tutor-editor">
      <label className="tutors-label">
        Provider
        <select
          className="live-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="none">None — voice only</option>
          <option value="simli">Simli (face ID)</option>
          <option value="lemonslice">LemonSlice (agent ID or photo URL)</option>
        </select>
      </label>
      {provider !== "none" && (
        <label className="tutors-label">
          Reference
          <input
            className="tutors-input"
            type="text"
            value={ref}
            placeholder={
              provider === "simli"
                ? "Simli face ID (from the Simli console)"
                : "LemonSlice agent ID, or a public https:// photo URL"
            }
            onChange={(e) => setRef(e.target.value)}
          />
          <span className="tutors-hint">
            The avatar vendor fetches this itself, so a photo URL must be
            publicly reachable — uploaded blobs aren't, yet.
          </span>
        </label>
      )}
      <div className="tutor-editor-row">
        <button type="button" className="ask-btn" disabled={busy} onClick={() => void save()}>
          Save avatar
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- create */

interface FormExchange extends TutorExchange {}

function CreateTutorForm({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("the learner's tutor");
  const [bio, setBio] = useState("");
  const [style, setStyle] = useState<string>("socratic");
  const [verbosity, setVerbosity] = useState<string>("medium");
  const [warmth, setWarmth] = useState<string>("medium");
  const [formality, setFormality] = useState<string>("low");
  const [onWrong, setOnWrong] = useState("asks what led the learner there before correcting");
  const [catchphrases, setCatchphrases] = useState("");
  const [neverDoes, setNeverDoes] = useState("says “Great question!”");
  const [fewShot, setFewShot] = useState<FormExchange[]>([{ student: "", tutor: "" }]);
  const [busy, setBusy] = useState(false);

  const slug = slugify(name);
  const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!slug) return;
    setBusy(true);
    try {
      await createTutor({
        id: slug,
        kind: "synthetic",
        identity: { name: name.trim(), relationship: relationship.trim(), bio: bio.trim() || null },
        speech: {
          catchphrases: csv(catchphrases).slice(0, 8),
          fillers: [],
          verbosity: verbosity as TutorSpec["speech"]["verbosity"],
          warmth: warmth as TutorSpec["speech"]["warmth"],
          formality: formality as TutorSpec["speech"]["formality"],
        },
        pedagogy: {
          style: style as TutorSpec["pedagogy"]["style"],
          patience: "high",
          on_wrong_answer: onWrong.trim() || "asks what led the learner there before correcting",
          analogy_sources: [],
        },
        few_shot: fewShot
          .filter((x) => x.student.trim() && x.tutor.trim())
          .slice(0, 12),
        never_does: neverDoes.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 10),
        voice: null, // assigned in the row editor after creation
        avatar: { provider: "none", avatar_ref: null },
      });
      setName("");
      setBio("");
      setCatchphrases("");
      setFewShot([{ student: "", tutor: "" }]);
      onCreated();
    } catch (err) {
      onError(`create failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="tutors-block tutors-create" onSubmit={submit}>
      <h3 className="tutors-h3">New tutor</h3>

      <div className="tutors-grid">
        <label className="tutors-label">
          Name
          <input
            className="tutors-input"
            type="text"
            value={name}
            placeholder="Professor Whiskers"
            onChange={(e) => setName(e.target.value)}
            required
          />
          {name && !slug && <span className="tutors-hint">name must start with a letter</span>}
          {slug && <span className="tutors-hint">id: {slug}</span>}
        </label>

        <label className="tutors-label">
          Who are they to the learner?
          <input
            className="tutors-input"
            type="text"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            required
          />
        </label>
      </div>

      <label className="tutors-label">
        Bio (a sentence or two the tutor may reference)
        <input
          className="tutors-input"
          type="text"
          value={bio}
          placeholder="A retired physics teacher who sails on weekends."
          onChange={(e) => setBio(e.target.value)}
        />
      </label>

      <div className="tutors-grid">
        <label className="tutors-label">
          Teaching style
          <select className="live-select" value={style} onChange={(e) => setStyle(e.target.value)}>
            {STYLES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="tutors-label">
          Verbosity
          <select className="live-select" value={verbosity} onChange={(e) => setVerbosity(e.target.value)}>
            {VERBOSITY.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="tutors-label">
          Warmth
          <select className="live-select" value={warmth} onChange={(e) => setWarmth(e.target.value)}>
            {LEVELS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="tutors-label">
          Formality
          <select className="live-select" value={formality} onChange={(e) => setFormality(e.target.value)}>
            {LEVELS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="tutors-label">
        When the learner gets it wrong, this tutor…
        <input className="tutors-input" type="text" value={onWrong} onChange={(e) => setOnWrong(e.target.value)} />
      </label>

      <label className="tutors-label">
        Catchphrases (comma-separated, used sparingly)
        <input
          className="tutors-input"
          type="text"
          value={catchphrases}
          placeholder="right then, let's have a look"
          onChange={(e) => setCatchphrases(e.target.value)}
        />
      </label>

      <label className="tutors-label">
        Never does (one per line — kills chatbot tics)
        <textarea
          className="tutors-input"
          rows={2}
          value={neverDoes}
          onChange={(e) => setNeverDoes(e.target.value)}
        />
      </label>

      <div className="tutors-label">
        Example exchanges (optional, but 3+ is what makes the voice stick)
        {fewShot.map((x, i) => (
          <div key={i} className="tutors-exchange">
            <input
              className="tutors-input"
              type="text"
              value={x.student}
              placeholder="Student: I don't get why the sign flips."
              onChange={(e) =>
                setFewShot(fewShot.map((y, j) => (j === i ? { ...y, student: e.target.value } : y)))
              }
            />
            <input
              className="tutors-input"
              type="text"
              value={x.tutor}
              placeholder="Tutor: Walk me through what you did to both sides."
              onChange={(e) =>
                setFewShot(fewShot.map((y, j) => (j === i ? { ...y, tutor: e.target.value } : y)))
              }
            />
          </div>
        ))}
        {fewShot.length < 8 && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setFewShot([...fewShot, { student: "", tutor: "" }])}
          >
            + another exchange
          </button>
        )}
      </div>

      <div className="tutor-editor-row">
        <button className="ask-btn" type="submit" disabled={!slug || busy}>
          {busy ? "Creating…" : "Create tutor"}
        </button>
        <span className="tutors-hint">Next: assign a voice — sessions need one.</span>
      </div>
    </form>
  );
}
