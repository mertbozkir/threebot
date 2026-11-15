function normalizePath(path: string): string[] | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts;
}

/** Filesystem paths from RPC are already decoded; percent signs are literal filename characters. */
export function workspaceFilePath(path: string): string | null {
  if (path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path) || /[\\\x00-\x1f\x7f]/.test(path)) return null;
  const parts = normalizePath(path);
  return parts?.length ? parts.join("/") : null;
}

/** Resolve local references without ever treating an HTTP URL as a workspace file. */
export function workspaceLinkPath(href: string, workspaceRoot: string, fromPath?: string): string | null {
  if (!workspaceRoot.startsWith("/") || workspaceRoot === "/" || /[\\\x00-\x1f\x7f]/.test(href)) return null;
  let source = href;
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname || url.search) return null;
      source = url.pathname;
    } catch { return null; }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")) return null;
  // Fragments identify content within the file, never a different resource.
  source = source.split("#", 1)[0];
  if (!source || source.includes("?")) return null;
  try { source = decodeURIComponent(source); } catch { return null; }
  if (/[\\\x00-\x1f\x7f?#]/.test(source) || /%[\da-f]{2}/i.test(source)) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")) return null;
  const root = normalizePath(workspaceRoot);
  if (!root?.length) return null;
  let parts: string[] | null;
  if (source.startsWith("/")) {
    const absolute = normalizePath(source);
    if (!absolute || !root.every((part, index) => part === absolute[index])) return null;
    parts = absolute.slice(root.length);
  } else {
    // Plain prose, web routes and anchors are not implicit filesystem links.
    if (!source.startsWith("./") && !source.startsWith("../") && !source.startsWith("library/") && !/\.[a-z\d]{1,12}$/i.test(source)) return null;
    const directory = fromPath ? fromPath.split("/").slice(0, -1).join("/") : "";
    parts = normalizePath(`${source.startsWith("library/") ? "" : directory}/${source}`);
  }
  return parts?.length ? parts.join("/") : null;
}

export function workspaceFileKind(path: string): "image" | "video" | "audio" | "html" | "pdf" | "sheet" | "doc" | "text" | "file" {
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|heic|tiff?)$/i.test(path)) return "image";
  if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(path)) return "video";
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(path)) return "audio";
  if (/\.html?$/i.test(path)) return "html";
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.xlsx$/i.test(path)) return "sheet";
  if (/\.docx$/i.test(path)) return "doc";
  if (/\.(md|txt|csv|json|ya?ml|xml|log|[cm]?[jt]sx?|css|sh|py|sql)$/i.test(path) || /(^|\/)(README|LICENSE)$/i.test(path)) return "text";
  return "file";
}

export type WorkspaceResource = { _tag: "workspace-file"; threadId: string; path: string };
export type LibraryResource = WorkspaceResource | { _tag: "attachment"; attachmentId: string; disposition?: "inline" | "attachment" };
