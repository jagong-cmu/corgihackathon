import { TutorShell } from "./ui/TutorShell";
import { MaterialsPanel } from "./ui/MaterialsPanel";

export default function App() {
  return (
    <>
      <TutorShell />
      {/* Self-contained Phase 3 upload widget (floating; own inline styles). */}
      <MaterialsPanel />
    </>
  );
}
