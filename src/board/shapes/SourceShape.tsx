/**
 * `show_source` — an excerpt of the learner's own material, on the board.
 *
 * This closes the loop the retrieval index opens. The learner uploads a
 * syllabus; the worker retrieves a chunk of it and puts the id in the model's
 * context; the model calls `show_source` with that id; this fetches the text
 * and shows it, so the tutor is teaching on top of the learner's own wording
 * rather than a paraphrase of it.
 *
 * The fetch re-checks the ACL server-side. The id has made a round trip through
 * the browser by the time it gets here, so this component cannot be the thing
 * that decides the learner is allowed to see it.
 */

import { useEffect, useState } from "react";
import { fetchChunk, type SourceChunk } from "../../api";

interface Props {
  id: string;
  chunkId: string | null;
  mergeFileRef: { linkedAccountId: string; remoteId: string } | null;
  userId: string | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; chunk: SourceChunk }
  | { status: "error"; message: string };

/** `upload://<uuid>/<filename>` back to something worth showing a person. */
function displayName(uri: string | null, title: string | null): string {
  if (title) return title;
  if (!uri) return "your materials";
  const withoutScheme = uri.replace(/^[a-z]+:\/\//, "");
  const last = withoutScheme.split("/").pop();
  return last ? decodeURIComponent(last) : uri;
}

export function SourceShape({ id, chunkId, mergeFileRef, userId }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!chunkId || !userId) return;
    let cancelled = false;
    setState({ status: "loading" });

    fetchChunk(userId, chunkId)
      .then((chunk) => {
        if (!cancelled) setState({ status: "ready", chunk });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ status: "error", message: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, [chunkId, userId]);

  if (mergeFileRef) {
    // The action plane (§7.2) can hand the model a file it fetched live, which
    // is not in the index and has no text here to render. Naming it is better
    // than an empty card.
    return (
      <figure className="shape shape-source is-unavailable" data-shape-id={id}>
        <figcaption className="source-caption">
          from a connected account · {mergeFileRef.remoteId}
        </figcaption>
        <p className="source-note">
          This document was fetched live and is not in the index, so its text
          cannot be shown here yet.
        </p>
      </figure>
    );
  }

  return (
    <figure className="shape shape-source" data-shape-id={id}>
      {state.status === "loading" && <p className="source-note">Fetching the excerpt…</p>}

      {state.status === "error" && (
        <p className="source-note is-error">Couldn't load that excerpt — {state.message}</p>
      )}

      {state.status === "ready" && (
        <>
          <figcaption className="source-caption">
            from {displayName(state.chunk.uri, state.chunk.title)}
          </figcaption>
          <blockquote className="source-text">{state.chunk.text}</blockquote>
        </>
      )}
    </figure>
  );
}
