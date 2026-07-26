/**
 * Text extraction from uploaded document bytes. Server-only (Node). Libraries
 * are lazy-imported inside each branch so they never load during the client
 * build and only cost startup when a matching file is actually ingested.
 *
 *   pdf  -> pdf-parse
 *   docx -> mammoth (raw text)
 *   pptx -> adm-zip (pull <a:t> text runs from ppt/slides/*.xml)
 *   txt/md/csv/json -> decode as UTF-8
 */

export type ExtractKind = "pdf" | "docx" | "pptx" | "text" | "unknown";

export interface Extracted {
  text: string;
  kind: ExtractKind;
}

function kindFor(fileName: string, mimeType?: string): ExtractKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const mt = (mimeType ?? "").toLowerCase();
  if (ext === "pdf" || mt.includes("pdf")) return "pdf";
  if (ext === "docx" || mt.includes("wordprocessingml")) return "docx";
  if (ext === "pptx" || mt.includes("presentationml")) return "pptx";
  if (["txt", "md", "markdown", "csv", "json", "text"].includes(ext) || mt.startsWith("text/"))
    return "text";
  return "unknown";
}

export async function extractText(
  bytes: Uint8Array,
  fileName: string,
  mimeType?: string
): Promise<Extracted> {
  const kind = kindFor(fileName, mimeType);
  const buf = Buffer.from(bytes);

  if (kind === "pdf") {
    // pdf-parse v2: `new PDFParse({ data }).getText()` (pdfjs-based).
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try {
      const out = await parser.getText();
      return { text: out.text ?? "", kind };
    } finally {
      await parser.destroy?.();
    }
  }

  if (kind === "docx") {
    const mammoth = await import("mammoth");
    const out = await mammoth.extractRawText({ buffer: buf });
    return { text: out.value, kind };
  }

  if (kind === "pptx") {
    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(buf);
    const slides = zip
      .getEntries()
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
    const parts: string[] = [];
    for (const s of slides) {
      const xml = s.getData().toString("utf8");
      const runs = xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [];
      const slideText = runs
        .map((r) => r.replace(/<\/?a:t>/g, ""))
        .join(" ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      if (slideText.trim()) parts.push(slideText.trim());
    }
    return { text: parts.join("\n\n"), kind };
  }

  if (kind === "text") {
    return { text: buf.toString("utf8"), kind };
  }

  // Unknown: best-effort UTF-8 decode (safe for anything text-ish).
  return { text: buf.toString("utf8"), kind: "unknown" };
}
