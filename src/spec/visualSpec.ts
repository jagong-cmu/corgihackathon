/**
 * ============================================================================
 *  VisualSpec — THE module boundary between the voice half and the visual half.
 * ============================================================================
 *
 * On every turn the shared LLM emits BOTH `spokenText` and a `VisualSpec`.
 *   - The voice teammate's TTS consumes `spokenText`.
 *   - THIS renderer consumes the `VisualSpec`.
 *
 * The LLM NEVER emits animation code or video. It emits this compact JSON.
 * A deterministic client-side renderer interprets it and PLAYS a draw-on
 * animation. "Live whiteboard drawing" is a render-layer effect, not a
 * generation-layer effect.
 *
 * This type is versioned (`specVersion`). Treat it as a shared contract:
 * changes here are changes to the interface with the voice module.
 */

export const SPEC_VERSION = 1 as const;

export type Track = "deterministic" | "freeform";

export type Primitive =
  | "function_plot"
  | "vector_diagram"
  | "geometry"
  | "number_line"
  | "animated_diagram"
  | "equation"
  | "freeform_scene";

/**
 * A single annotation layered onto a primitive.
 * `at` is primitive-specific: a scalar x-value (e.g. tangent at x=1) or an
 * [x, y] coordinate.
 */
export interface Annotation {
  type: string;
  at?: number | [number, number];
  label?: string;
}

/**
 * One ordered reveal step. `drawSequence` drives the animated draw-on order:
 * element `id` is revealed over `durationMs`.
 */
export interface DrawStep {
  id: string;
  element: string;
  durationMs: number;
}

/**
 * Optional sync cues tying a reveal step to the voice track. The renderer can
 * reveal step X when the voice hits phrase Y (`onPhrase`) or at time Z (`atMs`).
 * For now the voice is mocked: cues fire on a timer. The real cloned voice
 * plugs in later by calling `revealStep(stepId)`.
 */
export interface SyncCue {
  stepId: string;
  onPhrase?: string;
  atMs?: number;
}

export interface VisualSpec {
  specVersion: typeof SPEC_VERSION;
  track: Track;
  primitive: Primitive;
  /** Primitive-specific params. Validated per-primitive at render time. */
  content: Record<string, unknown>;
  annotations?: Annotation[];
  /** Ordered reveal order. */
  drawSequence: DrawStep[];
  /** Sync to speech. */
  syncCues?: SyncCue[];
}

/**
 * The pair emitted by the shared LLM on each turn. `spokenText` is handed to
 * the voice module; `visualSpec` is handed to this renderer.
 */
export interface TurnResult {
  spokenText: string;
  visualSpec: VisualSpec;
}

/* ----------------------------------------------------------------------------
 * Primitive-specific content shapes (documentation + typed helpers).
 * These are the expected `content` payloads. The zod validator in validate.ts
 * enforces them; these interfaces give renderers typed access.
 * ------------------------------------------------------------------------- */

export interface FunctionPlotContent {
  /** Expression in one variable `x`, e.g. "x^2", "sin(x)", "x^3 - 2*x". */
  fn: string;
  /** Visible domain [min, max]. */
  domain: [number, number];
  /** Optional visible range [min, max]; auto if omitted. */
  range?: [number, number];
}

export interface FreeformSceneContent {
  /** Which authored mascot rig to star. Demo path uses "trudy". */
  mascot?: string;
  /** Ordered beats of the illustrated explanation. */
  beats: Array<{
    id: string;
    /** Caption drawn onto the whiteboard for this beat. */
    caption: string;
    /** Optional mascot pose + expression for this beat. */
    pose?: string;
    expression?: string;
    /** Optional prop/label glyphs to reveal this beat. */
    props?: string[];
  }>;
}

export interface EquationContent {
  /** A TeX string, e.g. "\\frac{d}{dx} x^2 = 2x". */
  tex: string;
}

export interface VectorDiagramContent {
  /**
   * One or more 2D vectors. Each is drawn from `tail` (default origin) to `tip`.
   * Authoring tip-to-tail (each vector's tail = previous tip) + `showResultant`
   * demonstrates vector addition.
   */
  vectors: Array<{
    id: string;
    tail?: [number, number];
    tip: [number, number];
    label?: string;
    /** Marker ink: "blue" | "berry" | "sage" | "amber". */
    color?: string;
  }>;
  /** Draw the sum (origin → sum of all displacements) as a final resultant. */
  showResultant?: boolean;
  /** Symmetric view half-extent; auto-fit from the vectors when omitted. */
  extent?: number;
}

export interface NumberLineContent {
  min: number;
  max: number;
  /** Tick spacing (default 1). */
  step?: number;
  /** Labeled marks on the line. `open` renders a hollow (excluded) endpoint. */
  points?: Array<{ x: number; label?: string; color?: string; open?: boolean }>;
  /** A highlighted interval [from, to] drawn above the line. */
  interval?: { from: number; to: number; label?: string; color?: string };
}
