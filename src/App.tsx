/**
 * The lesson owns the session; everything else reads from it.
 *
 * `useLiveSession` is called once, here, so the room, the cue queue, and the
 * board are all one instance. The materials panel needs the learner id that
 * session produced, which is the only reason it is not a leaf of TutorShell.
 */
import { TutorShell } from "./ui/TutorShell";
import { MaterialsPanel } from "./ui/MaterialsPanel";
import { useLiveSession } from "./live/useLiveSession";

export default function App() {
  const session = useLiveSession();

  return (
    <>
      <TutorShell session={session} />
      <MaterialsPanel userId={session.userId} />
    </>
  );
}
