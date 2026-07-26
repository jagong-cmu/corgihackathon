/**
 * Tutor roster guardrails for sidebar-only tutor access. Run with
 * `npm run test:tutors`. Non-zero exit on any failure. No browser, no keys:
 * the prod server is spawned on a private port and only /api/* is exercised.
 *
 * What this protects (the drift that hid Nico on deployed hosts):
 *  1. BUILTIN_TUTORS (src/tutorApi.ts) — the client's no-backend floor —
 *     must list every deployed tutor, Nico included.
 *  2. liveTutorLibrary (api/_lib/tutorLibrary.ts) — the deployed-tier list —
 *     must agree with BUILTIN_TUTORS id-for-id, and honour/reject the
 *     TUTOR_LIBRARY env override safely.
 *  3. server/prod.ts must actually serve GET /api/live/tutors (parity with
 *     the dev plugin and the Vercel function) without breaking its siblings.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TUTORS } from "../src/tutorApi";
import { liveTutorLibrary } from "../api/_lib/tutorLibrary";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ------------------------------------------------ 1. client fallback roster
{
  const nico = BUILTIN_TUTORS.find((t) => t.id === "nico");
  check("BUILTIN_TUTORS includes nico", !!nico);
  check("nico has a voice", nico?.hasVoice === true);
  check("nico has an avatar provider", !!nico && nico.avatarProvider !== "none");
  const aayush = BUILTIN_TUTORS.find((t) => t.id === "aayush");
  check("BUILTIN_TUTORS includes aayush", !!aayush);
  check("aayush has a voice", aayush?.hasVoice === true);
  check("aayush has an avatar provider", !!aayush && aayush.avatarProvider !== "none");
  const ids = BUILTIN_TUTORS.map((t) => t.id);
  check("BUILTIN_TUTORS ids are unique", new Set(ids).size === ids.length);
}

// ------------------------------------- 2. deployed-tier library + override
{
  delete process.env.TUTOR_LIBRARY;
  const defaults = liveTutorLibrary();
  for (const id of ["ada", "coach-rios", "nico", "aayush"]) {
    check(`default library includes ${id}`, defaults.some((t) => t.id === id));
  }

  const builtinIds = new Set(BUILTIN_TUTORS.map((t) => t.id));
  const libraryIds = new Set(defaults.map((t) => t.id));
  check(
    "BUILTIN_TUTORS and liveTutorLibrary name the same tutors",
    builtinIds.size === libraryIds.size && [...builtinIds].every((id) => libraryIds.has(id)),
    "update src/tutorApi.ts and api/_lib/tutorLibrary.ts together"
  );

  process.env.TUTOR_LIBRARY = JSON.stringify([
    { id: "custom", name: "Custom", hasVoice: true, avatarProvider: "none" },
  ]);
  const overridden = liveTutorLibrary();
  check(
    "TUTOR_LIBRARY override is honoured",
    overridden.length === 1 && overridden[0].id === "custom"
  );

  process.env.TUTOR_LIBRARY = "{not json";
  check(
    "invalid TUTOR_LIBRARY JSON falls back to defaults",
    liveTutorLibrary().some((t) => t.id === "nico")
  );

  process.env.TUTOR_LIBRARY = JSON.stringify({ nope: true });
  check(
    "non-array TUTOR_LIBRARY falls back to defaults",
    liveTutorLibrary().some((t) => t.id === "nico")
  );

  process.env.TUTOR_LIBRARY = JSON.stringify([{ id: 1, name: 2 }]);
  check(
    "malformed tutor entries fall back to defaults",
    liveTutorLibrary().some((t) => t.id === "nico")
  );

  // Half-valid entries: id + name suffice, but the rest must default SAFELY
  // (hasVoice false keeps Start disabled) and extra operator fields must never
  // be served to clients verbatim.
  process.env.TUTOR_LIBRARY = JSON.stringify([
    { id: "ghost", name: "Ghost", internalNote: "operators-eyes-only" },
  ]);
  const ghost = liveTutorLibrary();
  check(
    "half-valid entry gets safe defaults",
    ghost.length === 1 && ghost[0].hasVoice === false && ghost[0].avatarProvider === "none"
  );
  check("extra operator fields are dropped", !("internalNote" in ghost[0]));
  delete process.env.TUTOR_LIBRARY;
}

// ---------------------------------------- 3. prod server route (live HTTP)

async function waitForServer(base: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/api/live/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

type Child = ReturnType<typeof spawn>;

/** Spawn the prod server on a random loopback port, retrying on collision.
 * The env is SCRUBBED — the child must never inherit real keys
 * (ANTHROPIC_API_KEY, LIVEKIT_*): it is a network-listening server, and
 * HOST=127.0.0.1 keeps it off the LAN for the test's lifetime. */
async function startServer(): Promise<{ child: Child; base: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(join(ROOT, "node_modules", ".bin", "tsx"), ["server/prod.ts"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", PORT: String(port), HOST: "127.0.0.1", TUTOR_LIBRARY: "" },
      // stderr passes through so a port collision or crash is visible.
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (await waitForServer(base)) return { child, base };
    child.kill();
  }
  return null;
}

async function main() {
  const server = await startServer();
  check("prod server starts", server !== null);
  if (!server) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
  const { child, base: BASE } = server;
  try {
    const res = await fetch(`${BASE}/api/live/tutors`);
    check("GET /api/live/tutors responds 200", res.status === 200);
    const body = (await res.json()) as { tutors?: { id: string; name: string }[] };
    check("response has a tutors array", Array.isArray(body.tutors));
    const served = new Set((body.tutors ?? []).map((t) => t.id));
    for (const id of ["ada", "coach-rios", "nico", "aayush"]) {
      check(`prod server serves ${id}`, served.has(id));
    }
    check(
      "served tutors have id + name strings",
      (body.tutors ?? []).every((t) => typeof t.id === "string" && typeof t.name === "string")
    );

    // Neighbours of the new route still answer (route insertion broke nothing).
    const health = await fetch(`${BASE}/api/live/health`);
    const healthBody = (await health.json()) as { configured?: unknown };
    check(
      "GET /api/live/health still works",
      health.status === 200 && typeof healthBody.configured === "boolean"
    );
    const unknown = await fetch(`${BASE}/api/nope`);
    check("unknown /api/* still 404s", unknown.status === 404);
    const posted = await fetch(`${BASE}/api/live/tutors`, { method: "POST" });
    check("POST /api/live/tutors is rejected (405)", posted.status === 405);
  } finally {
    child.kill();
  }

  console.log(failures === 0 ? "\nAll tutor roster checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${failures + 1} check(s) FAILED (crashed before the summary).`);
  process.exit(1);
});
