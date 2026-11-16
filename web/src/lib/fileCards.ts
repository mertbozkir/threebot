export type FileCardAccent = "pdf" | "sheet" | "doc" | "slides" | "other";

export const FILE_CARD_COLORS: Record<FileCardAccent, string> = {
  pdf: "#ff3b47",
  sheet: "#19c46e",
  doc: "#1d8cff",
  slides: "#ff9500",
  other: "#98989d",
};

export function fileCardAccent(name: string): FileCardAccent {
  const extension = /\.([a-z\d]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (extension === "pdf") return "pdf";
  if (["xlsx", "xls", "csv", "ods"].includes(extension)) return "sheet";
  if (["docx", "doc", "odt"].includes(extension)) return "doc";
  if (["pptx", "ppt", "odp"].includes(extension)) return "slides";
  return "other";
}

export function fileTypeLabel(name: string): string {
  switch (fileCardAccent(name)) {
    case "pdf": return "PDF document";
    case "sheet": return "Spreadsheet";
    case "doc": return "Word document";
    case "slides": return "Presentation";
    default: return "File";
  }
}

export function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes}B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return `${Number(value.toFixed(1))}${units[unit]}`;
}

export function aboutFilePrompt(fileName: string, workspacePath: string | null | undefined, text: string): string {
  return `About “${fileName}”${workspacePath ? ` (${workspacePath})` : ""}: ${text}`;
}

type HastNode = { type?: unknown; tagName?: unknown; value?: unknown; properties?: { href?: unknown }; children?: unknown };

/** A paragraph renders as a file card only when a workspace-file link is its entire content. */
export function soloFileLinkParagraph(node: unknown, resolve: (href: string) => string | null): { href: string; path: string; text: string } | null {
  if (!node || typeof node !== "object") return null;
  const paragraph = node as HastNode;
  if (paragraph.type !== "element" || paragraph.tagName !== "p") return null;
  const children = Array.isArray(paragraph.children) ? paragraph.children : [];
  if (children.length !== 1) return null;
  const link = children[0] as HastNode;
  if (link.type !== "element" || link.tagName !== "a") return null;
  const href = typeof link.properties?.href === "string" ? link.properties.href : "";
  const path = href ? resolve(href) : null;
  if (!path) return null;
  const text = (Array.isArray(link.children) ? link.children : [])
    .map((child) => (child as HastNode)?.type === "text" ? String((child as HastNode).value ?? "") : "")
    .join("");
  return { href, path, text };
}
