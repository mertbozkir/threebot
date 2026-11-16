import { useContext, useEffect, useState, type ReactNode } from "react";
import { FILE_CARD_COLORS, cachedFileSize, fileSizeFromHead, formatSize, type FileGlyphKind } from "../lib/fileCards";
import { workspaceAssetUrl } from "../lib/workspaceAssets";
import { workspaceClient } from "../lib/workspaceTransport";
import { WorkspaceFileContext } from "./WorkspaceResource";

const BANDS: Partial<Record<FileGlyphKind, { color: string; height: string }>> = {
  pdf: { color: FILE_CARD_COLORS.pdf, height: "31%" },
  sheet: { color: FILE_CARD_COLORS.sheet, height: "31%" },
  doc: { color: FILE_CARD_COLORS.doc, height: "31%" },
  slides: { color: FILE_CARD_COLORS.slides, height: "35%" },
};

function Lines({ widths, height, viewBox }: { widths: number[]; height: number; viewBox: string }) {
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox={viewBox} aria-hidden="true">
      <g className="fill-file-card-line">
        {widths.map((width, index) => (
          <rect key={index} x="5" y={4 + index * 8} width={width} height="3" rx="1.5" />
        ))}
      </g>
    </svg>
  );
}

function GlyphBody({ kind }: { kind: FileGlyphKind }) {
  switch (kind) {
    case "pdf":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 33 39" aria-hidden="true">
          <g className="fill-file-card-line">
            <rect x="5" y="4" width="10.5" height="3" rx="1.5" />
            <rect x="19" y="4" width="9" height="8" rx="2" />
            <rect x="5" y="12" width="23" height="3" rx="1.5" />
            <rect x="5" y="20" width="10.5" height="3" rx="1.5" />
          </g>
        </svg>
      );
    case "sheet":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 33 39" aria-hidden="true">
          <g className="stroke-file-card-grid" strokeWidth="1" fill="none">
            <path d="M11 0V27M22 0V27M0 6.75H33M0 13.5H33M0 20.25H33" />
          </g>
        </svg>
      );
    case "doc":
      return <Lines widths={[23, 23, 10.5]} height={39} viewBox="0 0 33 39" />;
    case "slides":
      return <Lines widths={[31, 15.5]} height={35} viewBox="0 0 41 35" />;
    case "json":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 33 39" aria-hidden="true">
          <g className="fill-file-card-line">
            <circle cx="6.5" cy="5.5" r="1.5" />
            <circle cx="12.5" cy="13.5" r="1.5" />
            <rect x="16" y="12" width="12" height="3" rx="1.5" />
            <circle cx="12.5" cy="21.5" r="1.5" />
            <rect x="16" y="20" width="12" height="3" rx="1.5" />
            <circle cx="6.5" cy="33.5" r="1.5" />
          </g>
        </svg>
      );
    case "text":
    case "other":
      return <Lines widths={[10.5, 23, 23, 10.5]} height={39} viewBox="0 0 33 39" />;
    case "archive":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 33 39" aria-hidden="true">
          <g className="fill-file-card-line">
            {[4, 10, 16, 22, 28].map((y, index) => (
              <rect key={y} x={index % 2 ? 16.5 : 13.5} y={y} width="3" height="5" rx="1.5" />
            ))}
          </g>
        </svg>
      );
    case "audio":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 33 39" aria-hidden="true">
          <g className="fill-file-card-line">
            <rect x="6.5" y="11.5" width="4" height="16" rx="2" />
            <rect x="14.5" y="8" width="4" height="23" rx="2" />
            <rect x="22.5" y="11.5" width="4" height="16" rx="2" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}

export function FileGlyph({ kind }: { kind: FileGlyphKind }) {
  const band = BANDS[kind];
  return (
    <span aria-hidden="true" data-glyph={kind}
      className={`relative shrink-0 overflow-hidden bg-file-card-tile ${kind === "slides" ? "h-[35px] w-[41px] rounded-[8px]" : "h-[39px] w-[33px] rounded-[7px]"}`}>
      <GlyphBody kind={kind} />
      {band && <span className="absolute inset-x-0 bottom-0" style={{ backgroundColor: band.color, height: band.height }} />}
    </span>
  );
}

/** The signed URL of a workspace file, for HEAD probes and playback. */
export function useWorkspaceAssetUrl(path: string | undefined): string | null {
  const threadId = useContext(WorkspaceFileContext)?.threadId ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!threadId || !path) return;
    let live = true;
    Promise.resolve().then(() => { workspaceClient(threadId); return workspaceAssetUrl({ _tag: "workspace-file", threadId, path }); })
      .then((signed) => { if (live) setUrl(signed); })
      .catch(() => {});
    return () => { live = false; };
  }, [threadId, path]);
  return url;
}

/** The Content-Length of a workspace file, probed once via HEAD on its signed URL. */
export function useFileSize(path: string | undefined, url: string | null): number | null {
  const threadId = useContext(WorkspaceFileContext)?.threadId ?? null;
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (!threadId || !path || !url) return;
    let live = true;
    void cachedFileSize(`${threadId}:${path}`, () => fileSizeFromHead(url)).then((bytes) => {
      if (live && bytes !== null) setSize(bytes);
    });
    return () => { live = false; };
  }, [threadId, path, url]);
  return size;
}

export function FileCard({ name, detail, kind, onOpen, buttonRef, workspacePath, children }: {
  name: string;
  detail: string;
  kind: FileGlyphKind;
  onOpen: () => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  workspacePath?: string;
  children?: ReactNode;
}) {
  const url = useWorkspaceAssetUrl(workspacePath);
  const size = useFileSize(workspacePath, url);
  return (
    <div className="group relative flex h-[72px] w-[355px] min-w-0 max-w-full items-center gap-[13px] rounded-[18px] border border-file-card-border bg-file-card-bg pr-6 pl-5">
      <button type="button" ref={buttonRef} onClick={onOpen} aria-label={`Open ${name}`} title={name}
        className="flex min-w-0 flex-1 items-center gap-[13px] rounded-xl text-left focus-visible:outline-2 focus-visible:outline-accent">
        <FileGlyph kind={kind} />
        <span className="min-w-0">
          <span className="block truncate text-[15px] leading-5">{name}</span>
          <span className="mt-[2px] block truncate text-[13px] leading-4 text-muted">{size !== null ? formatSize(size) ?? detail : detail}</span>
        </span>
      </button>
      {children && (
        <span className="pointer-events-none ml-auto grid w-[18px] shrink-0 place-items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          {children}
        </span>
      )}
    </div>
  );
}
