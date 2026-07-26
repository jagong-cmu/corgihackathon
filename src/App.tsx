import { TutorProvider, useTutors } from "./tutors/TutorContext";
import { TutorShell } from "./ui/TutorShell";
import { Sidebar } from "./ui/Sidebar";
import { CreateTutorModal } from "./ui/CreateTutorModal";
import { TutorsPanel } from "./ui/TutorsPanel";
import { LiveTutorProvider } from "./live/LiveTutorContext";

export default function App() {
  return (
    <TutorProvider>
      {/* Owns the live voice session (LiveKit room, audio, board cues) at the
          App level, so shell churn can't take a running session down. The
          session's face renders inside TutorShell's tutor card. */}
      <LiveTutorProvider>
        <TutorShell />
        {/* Left drawer (sessions, tutors, materials) + on-site tutor creation. */}
        <Sidebar />
        <CreateTutorModal />
        <ManagePanel />
      </LiveTutorProvider>
    </TutorProvider>
  );
}

/** The voice-tutor manager drawer, opened from the tutor card. */
function ManagePanel() {
  const { manageOpen, closeManage, personasChanged } = useTutors();
  return <TutorsPanel open={manageOpen} onClose={closeManage} onChanged={personasChanged} />;
}
