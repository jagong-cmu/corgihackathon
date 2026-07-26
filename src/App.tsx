import { TutorProvider } from "./tutors/TutorContext";
import { TutorShell } from "./ui/TutorShell";
import { Sidebar } from "./ui/Sidebar";
import { CreateTutorModal } from "./ui/CreateTutorModal";

export default function App() {
  return (
    <TutorProvider>
      <TutorShell />
      {/* Left drawer (sessions, tutors, materials) + on-site tutor creation. */}
      <Sidebar />
      <CreateTutorModal />
    </TutorProvider>
  );
}
