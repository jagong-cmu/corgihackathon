/**
 * Paragraph-aware chunking with overlap. Keeps semantically-coherent blocks
 * together and carries a small tail into the next chunk so a fact split across
 * a boundary is still retrievable.
 */

export interface ChunkOptions {
  /** Target chunk size in characters. */
  maxChars?: number;
  /** Overlap carried from the end of one chunk into the start of the next. */
  overlapChars?: number;
}

function splitSentences(s: string): string[] {
  // Coarse sentence split; good enough for chunk packing.
  return s.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [s];
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 1000;
  const overlapChars = opts.overlapChars ?? 150;

  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  // Break into paragraphs, then further break any paragraph longer than maxChars.
  const paragraphs: string[] = [];
  for (const para of normalized.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= maxChars) {
      paragraphs.push(p);
    } else {
      let buf = "";
      for (const sent of splitSentences(p)) {
        if (buf && (buf + " " + sent).length > maxChars) {
          paragraphs.push(buf.trim());
          buf = sent;
        } else {
          buf = buf ? buf + " " + sent : sent;
        }
      }
      if (buf.trim()) paragraphs.push(buf.trim());
    }
  }

  // Greedily pack paragraphs into chunks up to maxChars.
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    if (buf && (buf + "\n\n" + p).length > maxChars) {
      chunks.push(buf);
      // start next chunk with an overlap tail from the previous chunk
      const tail = buf.slice(Math.max(0, buf.length - overlapChars));
      buf = (overlapChars > 0 ? tail + "\n\n" : "") + p;
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  if (buf.trim()) chunks.push(buf);

  return chunks;
}
