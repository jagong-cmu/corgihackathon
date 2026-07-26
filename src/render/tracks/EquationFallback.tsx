/**
 * EquationFallback — the guardrail renderer. Any invalid/unknown spec degrades
 * to a plain KaTeX equation instead of a white screen. Also serves the
 * `equation` primitive directly.
 */
import { useMemo } from "react";
import katex from "katex";

interface Props {
  tex: string;
  /** When true, shows a small "fallback" tag so it's visible in testing. */
  isFallback?: boolean;
  note?: string;
}

export function EquationFallback({ tex, isFallback, note }: Props) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: true,
        throwOnError: false,
        errorColor: "#cc0000",
      });
    } catch {
      return "<span style='color:#cc0000'>equation error</span>";
    }
  }, [tex]);

  return (
    <div className="equation-fallback">
      {isFallback && (
        <div className="fallback-badge" title={note}>
          fallback · showing equation
        </div>
      )}
      {/* KaTeX output is sanitized markup from a trusted lib. */}
      <div
        className="katex-host"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
