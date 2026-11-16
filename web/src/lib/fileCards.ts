export type FileCardAccent = "pdf" | "sheet" | "doc" | "slides" | "other";

export const FILE_CARD_COLORS: Record<FileCardAccent, string> = {
  pdf: "#ff3b47",
  sheet: "#19c46e",
  doc: "#1d8cff",
  slides: "#ff6a13",
  other: "#98989d",
};

export type FileGlyphKind = "pdf" | "sheet" | "doc" | "slides" | "json" | "text" | "archive" | "audio" | "other";

const GLYPH_KINDS: [FileGlyphKind, string[]][] = [
  ["pdf", ["pdf"]],
  ["sheet", ["xlsx", "xls", "csv", "tsv", "ods"]],
  ["doc", ["docx", "doc", "odt"]],
  ["slides", ["pptx", "ppt", "key", "odp"]],
  ["json", ["json"]],
  ["archive", ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]],
  ["audio", ["mp3", "wav", "m4a", "ogg", "oga", "aac", "flac", "opus"]],
  ["text", ["txt", "md", "markdown", "html", "htm", "xml", "xsl", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "log", "sql", "css", "scss", "less", "sh", "bash", "zsh", "fish", "ps1", "bat", "py", "pyw", "rb", "php", "pl", "lua", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "swift", "kt", "kts", "go", "rs", "java", "c", "h", "cpp", "hpp", "cc", "hh", "cs", "m", "mm", "r", "jl", "dart", "scala", "groovy", "gradle", "vue", "svelte", "astro", "proto", "graphql", "gql", "prisma", "diff", "patch"]],
];

const GLYPH_BY_EXTENSION = new Map<string, FileGlyphKind>(
  GLYPH_KINDS.flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind] as const)),
);

export function fileGlyphKind(name: string): FileGlyphKind {
  const extension = /\.([a-z\d]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return GLYPH_BY_EXTENSION.get(extension) ?? "other";
}

export function fileCardAccent(name: string): FileCardAccent {
  const kind = fileGlyphKind(name);
  return kind === "pdf" || kind === "sheet" || kind === "doc" || kind === "slides" ? kind : "other";
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

export type MediaFileKind = "audio" | "video" | "image";

export function mediaFileKind(path: string): MediaFileKind | null {
  if (/\.(mp3|wav|m4a|ogg|oga|aac|flac|opus)$/i.test(path)) return "audio";
  if (/\.(mp4|m4v|mov|webm|ogv)$/i.test(path)) return "video";
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(path)) return "image";
  return null;
}

export function mediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export type MessageFileLink = { href: string; path: string; text: string };

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;

function outsideCode(text: string): string {
  let fence = "";
  return text.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0] ?? "";
      if (!fence) { fence = char; return ""; }
      if (char === fence) { fence = ""; return ""; }
    }
    return fence ? "" : line.replace(/`[^`\n]*`/g, " ");
  }).join("\n");
}

/** Every workspace-file link in a bot message, in document order, deduplicated by path. */
export function messageFileLinks(text: string, resolve: (href: string) => string | null): MessageFileLink[] {
  const links: MessageFileLink[] = [];
  const seen = new Set<string>();
  for (const match of outsideCode(text).matchAll(MARKDOWN_LINK)) {
    const path = resolve(match[2]);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    links.push({ href: match[2], path, text: match[1] });
  }
  return links;
}

/** The link of a paragraph that is nothing but that link; its file already renders as a card in flow. */
export function soloMarkdownLink(text: string, resolve: (href: string) => string | null): MessageFileLink | null {
  const match = /^\s*\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(text);
  const path = match ? resolve(match[2]) : null;
  return match && path ? { href: match[2], path, text: match[1] } : null;
}

export const FILE_STACK_LIMIT = 12;

export function stackPage<T>(files: T[], expanded: boolean): { files: T[]; hidden: number } {
  if (expanded || files.length <= FILE_STACK_LIMIT) return { files, hidden: 0 };
  return { files: files.slice(0, FILE_STACK_LIMIT), hidden: files.length - FILE_STACK_LIMIT };
}

export const MEDIA_ROW_LIMIT = 3;

export function mediaRowTiles(count: number): { visible: number; overlay: number | null } {
  if (count <= MEDIA_ROW_LIMIT) return { visible: count, overlay: null };
  return { visible: MEDIA_ROW_LIMIT, overlay: count - 2 };
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
