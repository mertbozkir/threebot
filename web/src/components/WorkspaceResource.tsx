import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { workspaceAssetUrl } from "../lib/workspaceAssets";
import { workspaceFileKind, workspaceLinkPath, type LibraryResource } from "../lib/workspaceLinks";
import { workspaceClient } from "../lib/workspaceTransport";
import { themedWorkspacePage } from "../lib/workspacePage";
import { parseCsv } from "../lib/vaultCsv";
import { useApp } from "../store";
import { Modal } from "./ui";
import { ImageViewer, useOpenImage, type ViewerImage } from "./ImageViewer";

export const WorkspaceFileContext = createContext<{ workspaceRoot: string; threadId: string | null; fromPath?: string; openFile: (path: string) => void } | null>(null);

export function WorkspaceMessageImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const workspace = useContext(WorkspaceFileContext);
  const path = typeof src === "string" && workspace ? workspaceLinkPath(src, workspace.workspaceRoot, workspace.fromPath) : null;
  const threadId = workspace?.threadId;
  const remote = !path && typeof src === "string" && /^(https?:)?\/\//i.test(src) ? src : null;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const viewerImage: ViewerImage | null = path && threadId ? { key: `workspace:${path}`, alt: alt ?? "", name: path.split("/").at(-1), resource: { _tag: "workspace-file", threadId, path } }
    : remote ? { key: `remote:${remote}`, alt: alt ?? "", src: remote } : null;
  const { ref, open, viewer } = useOpenImage(viewerImage);
  useEffect(() => {
    setUrl(null); setError(false);
    if (!path) return;
    if (!threadId) { setError(true); return; }
    let live = true;
    Promise.resolve().then(() => { workspaceClient(threadId); return workspaceAssetUrl({ _tag: "workspace-file", threadId, path }); }).then((signed) => {
      if (!signed.startsWith("/t3/")) throw new Error("Invalid asset response");
      if (live) setUrl(signed);
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [path, threadId, attempt]);
  if (!path || !workspace) {
    if (!remote) return <span>{alt ?? "Image unavailable"}</span>;
    return <InlineImage buttonRef={ref} src={remote} alt={alt} onOpen={open} viewer={viewer} />;
  }
  if (error) return <span role="status">Couldn't load image. <button className="underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button></span>;
  if (!url) return <span role="status">Loading image…</span>;
  return <InlineImage buttonRef={ref} src={url} alt={alt} onOpen={open} viewer={viewer} onError={() => setError(true)} />;
}

/** The tappable thumbnail of a chat image. Enter and Space open it, as on any button. */
function InlineImage({ buttonRef, src, alt, onOpen, onError, viewer }: { buttonRef: (element: HTMLElement | null) => void; src: string; alt?: string; onOpen: () => void; onError?: () => void; viewer: ReactNode }) {
  return <>
    <button type="button" ref={buttonRef} className="chat-inline-image" onClick={onOpen} aria-label={alt ? `Open image: ${alt}` : "Open image"} title={alt || undefined}>
      <img src={src} alt={alt ?? ""} onError={onError} draggable={false} />
    </button>
    {viewer}
  </>;
}

type ResourceState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; url: string; content: string | null };

/** Diagnose the failing boundary without logging signed URLs or file contents. */
function reportResourceFailure(stage: string, resource: LibraryResource | null, fileKind: string, error: unknown) {
  const message = error instanceof Error ? error.message.replace(/\?[^\s]*/g, "?[redacted]") : "Unknown resource error";
  console.error("[workspace-resource]", { stage, resourceType: resource?._tag, fileKind, message });
}

type ResourceViewerProps = { scopeThreadId?: string | null; resource: LibraryResource | null; title: string; fileKind?: ReturnType<typeof workspaceFileKind>; onClose: () => void; renderText?: (text: string) => ReactNode };

/** Use T3's signed resource endpoint for reads and previews, retaining the mounted conversation. Images open full screen. */
export function WorkspaceResourceViewer(props: ResourceViewerProps) {
  const workspaceContext = useContext(WorkspaceFileContext);
  const { resource, title, fileKind, onClose, scopeThreadId } = props;
  const kind = fileKind ?? workspaceFileKind(resource?._tag === "workspace-file" ? resource.path : title);
  if (kind !== "image" || !resource) return <ResourceSheet {...props} />;
  return <ImageViewer images={[{ key: JSON.stringify(resource), alt: title, name: title, resource }]} initialIndex={0} onClose={onClose} scopeThreadId={scopeThreadId ?? workspaceContext?.threadId ?? null} />;
}

function ResourceSheet({ resource, title, fileKind, onClose, renderText, scopeThreadId }: ResourceViewerProps) {
  const sidebarWidth = useApp(s => s.sidebarCompact ? 72 : s.sidebarWidth);
  const workspaceContext = useContext(WorkspaceFileContext);
  const ownerThreadId = scopeThreadId ?? workspaceContext?.threadId ?? null;
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => { const observer = new window.MutationObserver(() => setDark(document.documentElement.classList.contains("dark"))); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); return () => observer.disconnect(); }, []);
  const [state, setState] = useState<ResourceState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const resolvedFileKind = fileKind ?? workspaceFileKind(resource?._tag === "workspace-file" ? resource.path : title);
  const resourceKey = JSON.stringify(resource);
  useEffect(() => {
    if (!resource) { setState({ kind: "error" }); return; }
    let live = true;
    const controller = new AbortController();
    let stage = "sign";
    setState({ kind: "loading" });
    (async () => {
      if (resource._tag === "workspace-file") workspaceClient(resource.threadId);
      const url = await workspaceAssetUrl(resource, ownerThreadId);
      if (!url.startsWith("/t3/")) throw new Error("Invalid asset response");
      // Media elements report HTTP/decode failures themselves and support
      // streaming/range requests. Do not prefetch or buffer the complete file.
      if (["image", "video", "audio"].includes(resolvedFileKind)) {
        if (live) setState({ kind: "ready", url, content: null });
        return;
      }
      // An iframe load event also fires for HTTP error pages; verify documents.
      stage = "fetch";
      const response = await fetch(url, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error(`Asset HTTP ${response.status}`);
      // PDFs render unsandboxed (WebKit draws nothing in a sandboxed frame), so only a real PDF may load there.
      if (resolvedFileKind === "pdf" && response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/pdf") throw new Error("Asset is not a PDF");
      const content = (resolvedFileKind === "text" || resolvedFileKind === "html") ? await response.text() : null;
      if (content === null) await response.body?.cancel();
      if (live) setState({ kind: "ready", url, content });
    })().catch((error: unknown) => {
      if (!live) return;
      reportResourceFailure(stage, resource, resolvedFileKind, error);
      setState({ kind: "error" });
    });
    return () => { live = false; controller.abort(); };
  // Resource identity is stable even when callers construct a fresh object on render.
  }, [resourceKey, resolvedFileKind, attempt, ownerThreadId]);
  const failed = (error: unknown) => { reportResourceFailure("render", resource, resolvedFileKind, error); setState({ kind: "error" }); };
  return <Modal backdropClassName={resolvedFileKind === "html" ? "workspace-page-backdrop" : undefined} backdropStyle={resolvedFileKind === "html" ? { left: sidebarWidth } : undefined} title={title} onClose={onClose} className={`workspace-resource-sheet h-[85dvh] w-full max-w-[1100px] ${resolvedFileKind === "html" ? "workspace-page-sheet" : ""} ${resolvedFileKind === "html" || /\.csv$/i.test(title) ? "workspace-document-sheet" : ""}`}>
    <div className="scroll-thin min-h-0 flex-1 overflow-auto">
      {state.kind === "loading" && <p role="status" className="p-6 text-center text-[14px] text-muted">Loading file…</p>}
      {state.kind === "error" && <div role="alert" className="p-6 text-center text-[14px] text-muted"><p>Couldn't open this file. It may be unavailable or access may have expired.</p><button className="mt-3 rounded-full bg-active px-4 py-2 text-fg" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>}
      {state.kind === "ready" && <>
        {resolvedFileKind === "audio" && <audio src={state.url} preload="metadata" controls aria-label={title} className="mx-auto my-6 max-w-full" onError={(event) => failed(new Error(`Media error ${event.currentTarget.error?.code ?? "unknown"}`))} />}
        {resolvedFileKind === "video" && <video src={state.url} preload="metadata" controls className="mx-auto max-h-full max-w-full" onError={(event) => failed(new Error(`Media error ${event.currentTarget.error?.code ?? "unknown"}`))} />}
        {(resolvedFileKind === "html" || resolvedFileKind === "pdf") && <iframe src={state.url} srcDoc={resolvedFileKind === "html" && state.content !== null ? themedWorkspacePage(state.content, dark) : undefined} title={title} sandbox={resolvedFileKind === "html" ? "allow-scripts" : undefined} className="size-full border-0 bg-white" onError={failed} />}
        {resolvedFileKind === "text" && state.content !== null && <div className="chat-file-content md mx-auto max-w-[760px] px-6 py-6 text-[14.5px] leading-[1.6]">{renderText ? renderText(state.content) : /\.csv$/i.test(title) ? <CsvPreview text={state.content} /> : <pre className="whitespace-pre-wrap break-words">{state.content}</pre>}</div>}
        {resolvedFileKind === "file" && <p className="p-6 text-center text-[14px] text-muted">Preview isn't available for this file.</p>}
      </>}
    </div>
    {state.kind === "ready" && <div className="shrink-0 border-t border-line px-4 py-3"><a href={state.url} target="_blank" rel="noreferrer" className="text-[13px] underline">Open original file</a></div>}
  </Modal>;
}

function CsvPreview({ text }: { text: string }) {
  const rows = parseCsv(text);
  const [header = [], ...body] = rows;
  return <div className="csv-preview"><table><thead><tr>{header.map((value, i) => <th key={i}>{value}</th>)}</tr></thead><tbody>{body.slice(0, 500).map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value}</td>)}</tr>)}</tbody></table>{body.length > 500 && <p role="status">Preview shows the first 500 rows. Open the original for all rows.</p>}</div>;
}
