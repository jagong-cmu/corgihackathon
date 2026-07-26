/**
 * FreeformScene — Track 2 (freeform) renderer. (Phase 4/5 build this out.)
 *
 * Plays an authored Trudy scene: each beat reveals a caption (and later a
 * pose/expression change + props) in sync with narration via syncCues.
 *
 * This stub already honors the draw-sequence reveal + shows Trudy and the
 * per-beat captions, so the hero-demo plumbing is testable now. Phase 4 adds
 * animejs pose transitions and prop draw-on; Phase 5 grounds the beats in
 * Merge-retrieved Corgi facts.
 */
import type { DrawStep, FreeformSceneContent } from "../../spec/visualSpec";
import type { DrawSequenceState } from "../hooks/useDrawSequence";
import { Trudy, type TrudyPose, type TrudyExpression } from "../../mascot/Trudy";

interface Props {
  content: FreeformSceneContent;
  drawSequence: DrawStep[];
  state: DrawSequenceState;
}

export function FreeformScene({ content, state }: Props) {
  const beats = content.beats ?? [];
  // The active beat = the last revealed one (drives Trudy's current pose).
  const activeBeat =
    [...beats].reverse().find((b) => state.isRevealed(b.id)) ?? null;

  return (
    <div className="freeform-scene">
      <div className="freeform-stage">
        <Trudy
          pose={(activeBeat?.pose as TrudyPose) ?? "idle"}
          expression={(activeBeat?.expression as TrudyExpression) ?? "neutral"}
          size={240}
        />
      </div>
      <ol className="freeform-beats">
        {beats.map((b) => {
          const revealed = state.isRevealed(b.id);
          return (
            <li
              key={b.id}
              className={`beat ${revealed ? "beat-revealed" : "beat-hidden"}`}
            >
              {b.caption}
            </li>
          );
        })}
      </ol>
      {/* TODO(Phase 4): draw-on props via animejs; TODO(Phase 5): ground beats in Merge facts. */}
    </div>
  );
}
