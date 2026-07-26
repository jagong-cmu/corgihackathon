/**
 * FreeformScene — Track 2 (freeform) renderer.
 *
 * Plays an authored Trudy scene: each beat reveals a caption in sync with the
 * narration via syncCues. The corgi's pose/expression follow the active beat,
 * and a marker underline "draws" under the line currently being narrated.
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
  // The active beat = the last revealed one (drives Trudy + the underline).
  const activeBeat =
    [...beats].reverse().find((b) => state.isRevealed(b.id)) ?? null;

  return (
    <div className="freeform-scene">
      <div className="freeform-stage">
        <Trudy
          pose={(activeBeat?.pose as TrudyPose) ?? "wave"}
          expression={(activeBeat?.expression as TrudyExpression) ?? "happy"}
          size={230}
        />
      </div>
      <ol className="freeform-beats">
        {beats.map((b) => {
          const revealed = state.isRevealed(b.id);
          const active = activeBeat?.id === b.id;
          return (
            <li
              key={b.id}
              className={[
                "beat",
                revealed ? "beat-revealed" : "",
                active ? "beat-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="beat-bullet" aria-hidden />
              <span className="beat-text">{b.caption}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
