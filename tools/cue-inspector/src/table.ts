/**
 * The live table. Vanilla DOM, one element per row, updated in place — rows
 * mutate from pending to fired or cancelled and re-rendering the whole table on
 * every rAF tick would both flicker and lie about the cost of the tick loop.
 */

import { driftBand, type CueRow, type TurnState } from "./cue-queue.ts";

const COLUMNS = ["turn", "seq", "action", "cue ms", "actual ms", "drift ms", "arrived @", "state"];

export class CueTable {
  private readonly tbody: HTMLTableSectionElement;
  private readonly empty: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly turnBar: HTMLElement;
  private readonly elements = new Map<number, HTMLTableRowElement>();

  constructor(root: HTMLElement, summary: HTMLElement, turnBar: HTMLElement) {
    this.summary = summary;
    this.turnBar = turnBar;

    const table = document.createElement("table");
    table.className = "cues";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of COLUMNS) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    this.tbody = document.createElement("tbody");
    table.append(thead, this.tbody);

    this.empty = document.createElement("p");
    this.empty.className = "empty";
    this.empty.textContent =
      "No frames yet. Connect to a room, or run a fixture replay, and rows land here as they arrive.";

    root.append(table, this.empty);
  }

  addRow(row: CueRow): void {
    this.empty.style.display = "none";
    const tr = document.createElement("tr");
    tr.dataset.rowId = String(row.id);
    for (let i = 0; i < COLUMNS.length; i++) tr.append(document.createElement("td"));
    this.elements.set(row.id, tr);
    this.tbody.append(tr);
    this.updateRow(row);
    tr.scrollIntoView({ block: "nearest" });
  }

  updateRow(row: CueRow): void {
    const tr = this.elements.get(row.id);
    if (!tr) return;
    const cells = tr.children as HTMLCollectionOf<HTMLTableCellElement>;

    cells[0].textContent = row.turnId;
    cells[1].textContent = String(row.seq);
    cells[2].textContent = row.actionType;
    cells[3].textContent = fmt(row.cueMs);
    cells[4].textContent = row.actualMs === undefined ? "—" : fmt(row.actualMs);
    cells[5].textContent = row.driftMs === undefined ? "—" : signed(row.driftMs);
    cells[6].textContent = fmt(row.arrivalMs);
    cells[7].textContent = row.status === "cancelled" ? "cancelled" : row.status;

    cells[5].className = row.driftMs === undefined ? "" : `drift ${driftBand(row.driftMs)}`;
    cells[7].className = `state ${row.status}`;
    cells[7].title = row.cancelReason ?? "";
    tr.className = `row-${row.status}`;

    // A frame that arrived after its own cue time could not have fired on
    // time no matter what the client did. Flag it: that is a transport
    // problem, not a rendering one.
    if (row.arrivalMs > row.cueMs + 1) {
      cells[6].classList.add("late-arrival");
      cells[6].title = `Frame landed ${row.arrivalMs - row.cueMs}ms after its cue time — late on the wire.`;
    }
  }

  renderSummary(rows: readonly CueRow[]): void {
    const fired = rows.filter((r) => r.status === "fired");
    const cancelled = rows.filter((r) => r.status === "cancelled").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    const drifts = fired.map((r) => Math.abs(r.driftMs ?? 0));

    const bands = { good: 0, warn: 0, bad: 0 };
    for (const r of fired) bands[driftBand(r.driftMs ?? 0)]++;

    const worst = drifts.length ? Math.max(...drifts) : 0;
    const median = drifts.length ? [...drifts].sort((a, b) => a - b)[drifts.length >> 1] : 0;

    this.summary.innerHTML = "";
    this.summary.append(
      stat("fired", String(fired.length)),
      stat("pending", String(pending)),
      stat("cancelled", String(cancelled)),
      stat("median drift", drifts.length ? `${median}ms` : "—", drifts.length ? driftBand(median) : undefined),
      stat("worst drift", drifts.length ? `${worst}ms` : "—", drifts.length ? driftBand(worst) : undefined),
      stat("<50 / <150 / ≥150", `${bands.good} / ${bands.warn} / ${bands.bad}`),
    );
  }

  renderTurns(turns: readonly TurnState[]): void {
    this.turnBar.innerHTML = "";
    for (const turn of turns) {
      const chip = document.createElement("span");
      chip.className = `turn-chip${turn.cancelled ? " cancelled" : ""}`;
      chip.textContent = `${turn.turnId} · origin ${Math.round(turn.originMs)}ms`;
      chip.title = turn.cancelled
        ? "Turn cancelled — its unfired cues are marked in the table."
        : "Inferred start of this turn's audio, in playback-clock ms.";
      this.turnBar.append(chip);
    }
  }

  clear(): void {
    this.tbody.innerHTML = "";
    this.elements.clear();
    this.turnBar.innerHTML = "";
    this.empty.style.display = "";
  }
}

function stat(label: string, value: string, band?: "good" | "warn" | "bad"): HTMLElement {
  const el = document.createElement("div");
  el.className = "stat";
  const v = document.createElement("strong");
  v.textContent = value;
  if (band) v.classList.add(band);
  const l = document.createElement("span");
  l.textContent = label;
  el.append(v, l);
  return el;
}

const fmt = (ms: number) => `${Math.round(ms)}`;
const signed = (ms: number) => (ms > 0 ? `+${Math.round(ms)}` : `${Math.round(ms)}`);
