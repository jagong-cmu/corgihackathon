/**
 * The whiteboard.
 *
 * Sections stack vertically and are never discarded — the board is the
 * learner's reviewable notes (§5.2), so scrolling back through a lesson is the
 * feature, not a side effect. Each section is an 800x600 logical page and every
 * shape is placed at its section-relative coordinates, scaled to whatever width
 * the panel actually has.
 *
 * `camera` focus scrolls; it does not zoom. The protocol's only camera op is
 * "focus on this shape", and on a board that is one column of pages, scrolling
 * to it is exactly that. Zooming would also break the coordinate contract every
 * other action is written against.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SECTION_HEIGHT, SECTION_WIDTH, type BoardState, type Shape } from "./state";
import { EquationShape } from "./shapes/EquationShape";
import { StepsShape } from "./shapes/StepsShape";
import { GraphShape } from "./shapes/GraphShape";
import { SimShape } from "./shapes/SimShape";
import { SourceShape } from "./shapes/SourceShape";

/** The closed palette from the protocol, mapped to this board's theme. */
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "rgba(240, 200, 80, 0.45)",
  green: "rgba(120, 200, 130, 0.40)",
  blue: "rgba(120, 170, 235, 0.40)",
  red: "rgba(235, 130, 120, 0.40)",
  violet: "rgba(180, 145, 230, 0.40)",
  orange: "rgba(240, 170, 100, 0.45)",
  grey: "rgba(160, 160, 160, 0.35)",
};

/**
 * How much horizontal room a shape actually has.
 *
 * The agent lays a section out by choosing coordinates — steps at x=80, a graph
 * at x=420 means "steps on the left, graph on the right". Nothing in the
 * protocol carries widths, so the only way to honour that intent is to read it
 * off the neighbours: a shape may grow until it reaches the next shape placed
 * to its right on the same row, and no further.
 *
 * The row test is a band rather than an exact match because a model writing
 * y=160 and y=170 for two things it means to sit side by side is normal, and
 * treating those as different rows would let them overlap.
 */
const ROW_BAND = 160;

function availableWidth(shape: Shape, siblings: Shape[]): number {
  let right = SECTION_WIDTH;
  for (const other of siblings) {
    if (other.id === shape.id) continue;
    if (other.x <= shape.x) continue;
    if (Math.abs(other.y - shape.y) > ROW_BAND) continue;
    right = Math.min(right, other.x);
  }
  // A gutter, so neighbours never touch even at the tightest placement.
  return Math.max(120, right - shape.x - 16);
}

interface Props {
  board: BoardState;
  userId: string | null;
  onParameterChange(shapeId: string, name: string, value: number): void;
  onSelectShape(shapeId: string): void;
}

/**
 * The section's scale factor: rendered width / 800 logical units.
 *
 * Every shape is laid out in logical units and the whole page is scaled once,
 * which is what makes the coordinate contract real. Positioning in percentages
 * while sizing in pixels — the obvious shortcut — silently breaks it: a shape
 * the agent placed at x=420 expecting 380 units of room gets whatever CSS
 * decides its pixel width is, and shapes that were laid out side by side
 * overlap at some window sizes and not others.
 */
function useSectionScale(ref: React.RefObject<HTMLElement>): number {
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setScale(width / SECTION_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return scale;
}

export function Board({ board, userId, onParameterChange, onSelectShape }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const scale = useSectionScale(scrollerRef);

  // Camera focus. Keyed on the nonce so focusing the same shape twice still
  // scrolls — "look at this again" is a thing tutors say.
  const focusKey = board.focus ? `${board.focus.sectionIndex}:${board.focus.shapeId}:${board.focus.nonce}` : null;
  useEffect(() => {
    if (!board.focus) return;
    const target =
      (board.focus.shapeId &&
        scrollerRef.current?.querySelector(`[data-shape-id="${CSS.escape(board.focus.shapeId)}"]`)) ||
      sectionRefs.current.get(board.sections[board.focus.sectionIndex]?.id ?? "");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const isEmpty = board.sections.every((section) => section.shapes.length === 0);

  return (
    <div className="board-scroller" ref={scrollerRef}>
      {isEmpty && (
        <div className="board-empty">
          <p>The board fills in as the tutor talks.</p>
          <p className="board-empty-sub">
            Ask something out loud — a derivation, a graph, a question about a
            document you uploaded.
          </p>
        </div>
      )}

      {board.sections.map((section, index) => (
        <section
          key={section.id}
          className={`board-section${index === board.activeSectionIndex ? " is-active" : ""}`}
          ref={(el) => {
            if (el) sectionRefs.current.set(section.id, el);
            else sectionRefs.current.delete(section.id);
          }}
          hidden={index === 0 && !section.title && section.shapes.length === 0 && board.sections.length > 1}
        >
          {section.title && <h2 className="section-title">{section.title}</h2>}

          {/* The scaled logical page. Height is reserved on the wrapper because
              a CSS transform does not affect layout — without it every section
              after the first would be drawn on top of this one. */}
          <div className="section-viewport" style={{ height: SECTION_HEIGHT * scale }}>
            <div
              className="section-page"
              style={{
                width: SECTION_WIDTH,
                height: SECTION_HEIGHT,
                transform: `scale(${scale})`,
              }}
            >
              {section.shapes.map((shape) => (
                <PlacedShape
                  key={shape.id}
                  shape={shape}
                  width={availableWidth(shape, section.shapes)}
                  board={board}
                  userId={userId}
                  onParameterChange={onParameterChange}
                  onSelectShape={onSelectShape}
                />
              ))}

              {board.pointer?.sectionIndex === index && (
                <span
                  className={`board-pointer is-${board.pointer.style}`}
                  style={{ left: board.pointer.x, top: board.pointer.y }}
                  aria-hidden
                />
              )}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function PlacedShape({
  shape,
  width,
  board,
  userId,
  onParameterChange,
  onSelectShape,
}: {
  shape: Shape;
  width: number;
  board: BoardState;
  userId: string | null;
  onParameterChange(shapeId: string, name: string, value: number): void;
  onSelectShape(shapeId: string): void;
}) {
  const highlight = board.highlights[shape.id];
  const color = highlight ? HIGHLIGHT_COLORS[highlight.color] ?? HIGHLIGHT_COLORS.yellow : undefined;

  // A whole-shape highlight washes the container; a sub-target highlight is the
  // shape's own business, so it is passed down instead.
  const wholeShape = highlight && !highlight.sub;

  const style = useMemo(
    () => ({
      left: shape.x,
      top: shape.y,
      maxWidth: width,
      maxHeight: SECTION_HEIGHT - shape.y - 8,
      ...(wholeShape ? { background: color, boxShadow: `0 0 0 6px ${color}` } : {}),
    }),
    [shape.x, shape.y, width, wholeShape, color],
  );

  return (
    <div
      className={`board-shape${wholeShape ? " is-highlighted" : ""}`}
      style={style}
      onClick={() => onSelectShape(shape.id)}
    >
      {renderShape(shape, highlight?.sub ?? null, color, userId, onParameterChange)}
    </div>
  );
}

function renderShape(
  shape: Shape,
  sub: string | null,
  color: string | undefined,
  userId: string | null,
  onParameterChange: (shapeId: string, name: string, value: number) => void,
) {
  switch (shape.kind) {
    case "equation":
      return (
        <EquationShape
          id={shape.id}
          latex={shape.latex}
          highlightedSub={sub}
          highlightColor={color}
        />
      );
    case "steps":
      return (
        <StepsShape
          id={shape.id}
          lines={shape.lines}
          revealed={shape.revealed}
          highlightedSub={sub}
          highlightColor={color}
        />
      );
    case "graph":
      return (
        <GraphShape
          id={shape.id}
          spec={shape.spec}
          parameters={shape.parameters}
          onParameterChange={(name, value) => onParameterChange(shape.id, name, value)}
        />
      );
    case "sim":
      return (
        <SimShape
          id={shape.id}
          spec={shape.spec}
          playing={shape.playing}
          speed={shape.speed}
          params={shape.params}
        />
      );
    case "source":
      return (
        <SourceShape
          id={shape.id}
          chunkId={shape.chunkId}
          mergeFileRef={shape.mergeFileRef}
          userId={userId}
        />
      );
    default:
      // Unreachable while the union is exhaustive, but an unknown shape must
      // render nothing rather than crash the board (§13).
      return null;
  }
}
