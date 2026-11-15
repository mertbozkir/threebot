import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Download, File, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, LoaderCircle } from "lucide-react";
import { assetUrl } from "../store";
import { workspaceFileKind } from "../lib/workspaceLinks";
import { WorkspaceResourceViewer } from "./WorkspaceResource";
import { useOpenImage } from "./ImageViewer";

type FileKind = ReturnType<typeof workspaceFileKind>;
type ChatAttachment = { id: string; name: string; type: "image" | "file"; fileKind: FileKind; mimeType: string | null; sizeBytes: number | null; previewUrl?: string };

const MIME_FORMATS = new Map<string, { label: string; kind: FileKind }>([
  ["image/png", { label: "PNG", kind: "image" }], ["image/jpeg", { label: "JPEG", kind: "image" }],
  ["image/gif", { label: "GIF", kind: "image" }], ["image/webp", { label: "WEBP", kind: "image" }],
  ["image/avif", { label: "AVIF", kind: "image" }], ["image/bmp", { label: "BMP", kind: "image" }],
  ["image/svg+xml", { label: "SVG", kind: "image" }], ["image/tiff", { label: "TIFF", kind: "image" }],
  ["image/heic", { label: "HEIC", kind: "image" }], ["image/heif", { label: "HEIF", kind: "image" }],
  ["image/x-icon", { label: "ICO", kind: "image" }], ["image/vnd.microsoft.icon", { label: "ICO", kind: "image" }],
  ["video/mp4", { label: "MP4", kind: "video" }], ["video/webm", { label: "WEBM", kind: "video" }],
  ["video/quicktime", { label: "MOV", kind: "video" }], ["video/ogg", { label: "OGV", kind: "video" }],
  ["application/pdf", { label: "PDF", kind: "pdf" }], ["text/html", { label: "HTML", kind: "html" }],
  ["text/plain", { label: "Text", kind: "text" }], ["text/csv", { label: "CSV", kind: "text" }],
  ["text/tab-separated-values", { label: "TSV", kind: "text" }], ["text/markdown", { label: "Markdown", kind: "text" }],
  ["application/json", { label: "JSON", kind: "text" }], ["application/xml", { label: "XML", kind: "text" }],
  ["text/xml", { label: "XML", kind: "text" }], ["text/css", { label: "CSS", kind: "text" }],
  ["text/javascript", { label: "JavaScript", kind: "text" }], ["application/javascript", { label: "JavaScript", kind: "text" }],
  ["application/yaml", { label: "YAML", kind: "text" }], ["text/yaml", { label: "YAML", kind: "text" }],
]);

function sizeLabel(bytes: number | null) {
  if (bytes === null) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unit = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${Number((bytes / 1024 ** unit).toFixed(unit ? 1 : 0))} ${units[unit]}`;
}

function presentation(attachment: ChatAttachment) {
  const extension = /^(.+)\.([a-z\d]{1,12})$/i.exec(attachment.name);
  const format = MIME_FORMATS.get(attachment.mimeType ?? "");
  const label = extension?.[2].toUpperCase() ?? format?.label ?? (attachment.type === "image" ? "Image" : "File");
  const size = sizeLabel(attachment.sizeBytes);
  const Icon = attachment.fileKind === "image" ? FileImage : attachment.fileKind === "video" ? FileVideo
    : /^(CSV|TSV|XLSX?|ODS)$/.test(label) ? FileSpreadsheet
    : attachment.fileKind === "html" || /^(JSON|XML|YAML|YML|JS|TS|PY|SH|CSS)$/.test(label) ? FileCode
    : attachment.fileKind === "text" || attachment.fileKind === "pdf" || attachment.fileKind === "doc" ? FileText : File;
  return { name: extension?.[1] ?? attachment.name, detail: size ? `${label} · ${size}` : label, Icon };
}

function attachmentsFrom(values: unknown[]): ChatAttachment[] {
  return values.flatMap((value): ChatAttachment[] => {
    if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" || !value.id.trim() || value.id.length > 256) return [];
    const name = "name" in value && typeof value.name === "string" && value.name.trim().length ? value.name : "Attachment";
    const mime = "mimeType" in value && typeof value.mimeType === "string" && value.mimeType.length <= 256 ? value.mimeType.split(";", 1)[0].trim().toLowerCase() : "";
    const mimeType = /^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/.test(mime) ? mime : null;
    const fileKind = MIME_FORMATS.get(mimeType ?? "")?.kind ?? ("type" in value && value.type === "image" ? "image" : workspaceFileKind(name));
    const sizeBytes = "sizeBytes" in value && typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 ? value.sizeBytes : null;
    return [{ id: value.id, name, type: fileKind === "image" ? "image" : "file", fileKind, mimeType, sizeBytes, previewUrl: "previewUrl" in value && typeof value.previewUrl === "string" ? value.previewUrl : undefined }];
  });
}

export function ChatAttachmentList({ attachments, align = "end" }: { attachments: unknown[]; align?: "start" | "end" }) {
  const items = useMemo(() => attachmentsFrom(attachments), [attachments]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((item) => item.id === selectedId);
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  const resource: { _tag: "attachment"; attachmentId: string; disposition?: "inline" } | null = selected
    ? { _tag: "attachment", attachmentId: selected.id, ...(!["file", "sheet", "doc"].includes(selected.fileKind) ? { disposition: "inline" } : {}) }
    : null;
  return <>
    <div className={clsx("chat-attachments mb-1 flex min-w-0 flex-wrap gap-1.5", align === "start" ? "justify-start" : "justify-end")}>
      {items.map((attachment) => <Attachment key={attachment.id} attachment={attachment} onOpen={() => setSelectedId(attachment.id)} />)}
    </div>
    {selected && <WorkspaceResourceViewer key={selected.id} resource={resource} title={selected.name} fileKind={selected.fileKind} onClose={() => setSelectedId(null)} />}
  </>;
}

function Attachment({ attachment, onOpen }: { attachment: ChatAttachment; onOpen: () => void }) {
  const [thumbnail, setThumbnail] = useState<string | null>(attachment.previewUrl ?? null);
  const [downloadState, setDownloadState] = useState<"idle" | "preparing" | "started" | "error">("idle");
  const operation = useRef<symbol | null>(null);
  useEffect(() => {
    let live = true;
    setThumbnail(attachment.previewUrl ?? null); setDownloadState("idle");
    if (attachment.type === "image" && !attachment.previewUrl) {
      assetUrl({ _tag: "attachment", attachmentId: attachment.id, disposition: "inline" }).then((url) => {
        if (!url.startsWith("/t3/")) throw new Error("Invalid asset response");
        if (live) setThumbnail(url);
      }).catch(() => { if (live) setThumbnail(null); });
    }
    return () => { live = false; operation.current = null; };
  }, [attachment.id, attachment.name, attachment.previewUrl, attachment.type]);
  const download = async () => {
    if (operation.current) return;
    const token = Symbol(); operation.current = token; setDownloadState("preparing");
    try {
      const url = await assetUrl({ _tag: "attachment", attachmentId: attachment.id, disposition: "attachment" });
      if (operation.current !== token) return;
      if (!url.startsWith("/t3/")) throw new Error("Invalid asset response");
      const link = document.createElement("a");
      link.href = url; link.download = attachment.name; link.hidden = true;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
      operation.current = null; setDownloadState("started");
    } catch {
      if (operation.current === token) { operation.current = null; setDownloadState("error"); }
    }
  };
  const image = attachment.type === "image" && thumbnail;
  // Image attachments join their message's gallery; other files open in the resource sheet.
  const { ref, open, viewer } = useOpenImage(attachment.fileKind === "image" ? { key: `attachment:${attachment.id}`, alt: attachment.name, name: attachment.name,
    resource: { _tag: "attachment", attachmentId: attachment.id, disposition: "inline" }, download: { _tag: "attachment", attachmentId: attachment.id, disposition: "attachment" } } : null);
  const { name, detail, Icon } = presentation(attachment);
  return <div className="min-w-0 max-w-full">
    <div className={clsx("chat-attachment group relative flex min-w-0 max-w-full items-center gap-1 rounded-2xl", !image && "bg-card pr-1")}>
      <button type="button" ref={ref} onClick={attachment.fileKind === "image" ? open : onOpen} aria-label={`Open ${attachment.name}`} title={attachment.name} className={clsx("min-w-0 overflow-hidden rounded-2xl text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent", !image && "flex items-center gap-2.5 px-3 py-2.5 text-[13px]")}>
        {image ? <img src={thumbnail} alt={attachment.name} onError={() => setThumbnail(null)} className="chat-attachment-image max-h-56 max-w-[260px] rounded-2xl border border-line object-cover" />
          : <><Icon size={22} aria-hidden="true" className="shrink-0 text-muted" /><span className="min-w-0"><span className="block break-words leading-5">{name}</span><span className="block text-[11px] leading-4 text-muted">{detail}</span></span></>}
      </button>
      <button type="button" onClick={download} disabled={downloadState === "preparing"} aria-label={`Download ${attachment.name}`} title={`Download ${attachment.name}`}
        className={clsx("grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50", image && "absolute right-1 bottom-1 border border-line bg-elevated/90")}>
        {downloadState === "preparing" ? <LoaderCircle size={15} aria-hidden="true" className="animate-spin" /> : <Download size={15} aria-hidden="true" />}
      </button>
    </div>
    {downloadState === "error" && <p role="alert" className="px-2 pt-1 text-[12px] text-muted">Couldn't download. Try again.</p>}
    {viewer}
    <span role="status" className="sr-only">{downloadState === "started" ? "Download started." : downloadState === "preparing" ? "Preparing download…" : ""}</span>
  </div>;
}
