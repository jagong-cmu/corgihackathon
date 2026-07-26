/**
 * Avatar — renders whichever tutor is active.
 *
 *   - built-in "Trudy"  -> the hand-built animated SVG rig (poses/expressions)
 *   - a custom tutor     -> their captured/uploaded photo, cropped to a circle
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
  if (tutor.kind === "custom" && tutor.photo) {
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
  return <Trudy pose={pose} expression={expression} size={size} />;
}
