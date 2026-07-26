import { TutorProvider } from "./tutors/TutorContext";
import { TutorShell } from "./ui/TutorShell";
import { Sidebar } from "./ui/Sidebar";
import { CreateTutorModal } from "./ui/CreateTutorModal";
import { LiveTutorDock } from "./live/LiveTutorDock";

export default function App() {
  return (
    <TutorProvider>
      <TutorShell />
      {/* Left drawer (sessions, tutors, materials) + on-site tutor creation. */}
      <Sidebar />
      <CreateTutorModal />
      {/* Floating live voice session (LiveKit agent + avatar) — deliberately
          self-contained and mounted here, not in the shell. */}
      <LiveTutorDock />
    </TutorProvider>
  );
}
