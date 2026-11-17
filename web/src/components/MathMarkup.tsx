import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

export default function MathMarkup({ source, display }: { source: string; display: boolean }) {
  const html = useMemo(() => source.length <= 20000 ? katex.renderToString(source, {
    displayMode: display, output: "htmlAndMathml", trust: false, throwOnError: false,
    strict: "ignore", maxExpand: 1000, maxSize: 20,
  }) : null, [source, display]);
  if (html === null) return <code className="rich-math-literal">{source}</code>;
  return <span className={display ? "rich-math rich-math-display" : "rich-math"} dangerouslySetInnerHTML={{ __html: html }} />;
}
