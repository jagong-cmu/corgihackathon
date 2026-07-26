/**
 * `spawn_sim` — the analogy engine's placeholder.
 *
 * **This does not simulate anything, and that is deliberate.** §6 describes a
 * deterministic, physically-correct engine with a template registry, themed
 * sprite packs, and seeded replay. None of that exists on either side of the
 * repo yet, and a plausible-looking approximation would be worse than nothing
 * here: the tutor narrates *against* the simulation ("right at the impact, both
 * arrows appear at the same instant"), so a sim that is subtly wrong makes the
 * tutor appear to be lying about something the learner can see.
 *
 * What this does instead is render the spec faithfully and stay live: the
 * objects, the parameters, and the current transport state. `sim_control` and
 * `sim_update` visibly change it, so the action stream is legible end to end and
 * the day the engine lands it drops in behind an interface that already works.
 */

import type { SimSpec } from "@tutor/canvas-protocol";

interface Props {
  id: string;
  spec: SimSpec;
  playing: boolean;
  speed: number;
  params: Record<string, number | string | boolean>;
}

const TEMPLATE_LABELS: Record<string, string> = {
  collision_2body: "two-body collision",
  projectile: "projectile motion",
  inclined_plane: "inclined plane",
  pendulum: "pendulum",
  distribution_sampler: "sampling distribution",
  function_explorer: "function explorer",
  timeline: "timeline",
  labeled_diagram: "labeled diagram",
  annotated_map: "annotated map",
  flow_diagram: "flow diagram",
  p5_sketch: "custom sketch",
};

export function SimShape({ id, spec, playing, speed, params }: Props) {
  const label = TEMPLATE_LABELS[spec.template] ?? spec.template;

  return (
    <div className="shape shape-sim" data-shape-id={id}>
      <header className="sim-header">
        <span className="sim-badge">simulation</span>
        <span className="sim-title">
          {label}
          {spec.theme ? ` · ${spec.theme}` : ""}
        </span>
        <span className={`sim-transport${playing ? " is-playing" : ""}`}>
          {playing ? "▶" : "❚❚"}
          {speed !== 1 && <em>{speed}×</em>}
        </span>
      </header>

      <div className="sim-stage" aria-label={`${label} simulation`}>
        {spec.objects.map((object, i) => (
          <div key={i} className="sim-object">
            <span className="sim-sprite" data-sprite={object.sprite} />
            <span className="sim-object-label">{object.label ?? object.sprite}</span>
            <span className="sim-object-detail">
              {[
                object.mass !== undefined ? `m ${object.mass}` : null,
                object.v !== undefined ? `v ${object.v}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ))}
      </div>

      {Object.keys(params).length > 0 && (
        <dl className="sim-params">
          {Object.entries(params).map(([key, value]) => (
            <div key={key} className="sim-param">
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {(spec.overlays ?? []).length > 0 && (
        <ul className="sim-overlays">
          {(spec.overlays ?? []).map((overlay) => (
            <li key={overlay}>{overlay.replace(/_/g, " ")}</li>
          ))}
        </ul>
      )}

      <p className="sim-note">
        The analogy engine isn't built — this shows what the tutor asked for and
        stays in sync with it.
      </p>
    </div>
  );
}
