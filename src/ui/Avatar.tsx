/**
 * Avatar — renders whichever tutor is active.
 *
 *   - built-in "Trudy"        -> the hand-built animated SVG rig
 *   - any tutor with a photo  -> the photo (captured, uploaded, or the persona
 *                                API's avatar photo), cropped to a circle
 *   - a persona without one   -> a monogram disc in the tutor's accent
 *
 * Used everywhere a tutor face appears (left tutor card, presenter face-cam,
 * sidebar roster) so a created tutor shows up consistently across the app.
 */
import { Trudy, type TrudyPose, type TrudyExpression } from "../mascot/Trudy";
import type { Tutor } from "../tutors/TutorContext";
import "./avatar.css";

interface Props {
  tutor: Tutor;
  size?: number;
  pose?: TrudyPose;
  expression?: TrudyExpression;
}

export function Avatar({ tutor, size = 168, pose = "idle", expression = "happy" }: Props) {
  if (tutor.kind !== "builtin" && tutor.photo) {
    return (
      <img
        className="avatar-photo"
        src={tutor.photo}
        alt={`${tutor.name} (tutor)`}
        width={size}
        height={size}
        style={{ width: size, height: size, borderColor: tutor.accent }}
        draggable={false}
      />
    );
  }
  if (tutor.kind !== "builtin") {
    return (
      <span
        className="avatar-monogram"
        role="img"
        aria-label={`${tutor.name} (tutor)`}
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.42),
          color: tutor.accent ?? "#2f5fb0",
        }}
      >
        {(tutor.name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  return <Trudy pose={pose} expression={expression} size={size} />;
}
