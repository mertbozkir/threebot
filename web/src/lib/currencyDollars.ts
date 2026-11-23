// A dollar sign followed by an amount ("$36", "$0.04/hour", "$1.2k") is a price, not math.
// Without this, two prices on one line ("$36 … $0.04") read as one inline formula.
const PRICE = /(^|[^\\$\p{L}\p{N}_])\$(?=\d[\d,]*(?:\.\d+)?(?:[kKmMbB]n?|%)?(?:[\s.,;:!?)\]/–—-]|$))/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function escapeText(text: string) {
  return text.replace(PRICE, "$1\\$");
}

/** Escapes price dollar signs outside code, so remark-math leaves them as text. */
export function escapePriceDollars(markdown: string): string {
  if (!markdown.includes("$")) return markdown;
  let fence: string | null = null;
  return markdown.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.slice(line.indexOf(marker) + marker.length).trim()) fence = null;
      return line;
    }
    if (marker) { fence = marker; return line; }
    // Inline code spans keep their dollars.
    return line.split(/(`+[^`]*?`+)/).map((part, index) => (index % 2 ? part : escapeText(part))).join("");
  }).join("\n");
}
