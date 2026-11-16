import { useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { FILE_CARD_COLORS, cachedFileSize, fileSizeFromHead, formatSize, type FileGlyphKind } from "../lib/fileCards";
import { workspaceAssetUrl } from "../lib/workspaceAssets";
import { workspaceClient } from "../lib/workspaceTransport";
import { WorkspaceFileContext } from "./WorkspaceResource";

type Mark = readonly [x: number, y: number, width: number, height: number, radius: number];

/** A 4px bar on the 7px rhythm all tiles share. */
const bar = (y: number, width: number, x = 4.5): Mark => [x, y, width, 4, 2];
const dot = (x: number, y: number): Mark => [x, y, 4, 4, 2];
const TEXT: readonly Mark[] = [bar(4.5, 11), bar(11.5, 24), bar(18.5, 24), bar(25.5, 11)];

/** Tile contents in CSS pixels, measured from the outer edge of a 33x41 tile (41x35 for slides). */
const GLYPHS: Record<FileGlyphKind, { marks?: readonly Mark[]; fill?: string; grid?: string; band?: { color: string; top: number } }> = {
  pdf: { marks: [bar(4.5, 24), bar(11.5, 11), bar(18.5, 11), [17.5, 11.5, 11, 11, 1.5]], band: { color: FILE_CARD_COLORS.pdf, top: 28.5 } },
  doc: { marks: [bar(4.5, 24), bar(11.5, 24), bar(18.5, 11)], band: { color: FILE_CARD_COLORS.doc, top: 28.5 } },
  sheet: { grid: "M10.75 0V28.5M21.75 0V28.5M0 6.25H33M0 11.75H33M0 17.75H33M0 23.25H33", band: { color: FILE_CARD_COLORS.sheet, top: 28.5 } },
  slides: { marks: [bar(4.5, 31.5), bar(11.5, 14.5)], band: { color: FILE_CARD_COLORS.slides, top: 22.5 } },
  json: { marks: [dot(4.5, 4.5), dot(8.5, 11.5), bar(11.5, 14, 14.5), dot(8.5, 18.5), bar(18.5, 14, 14.5), dot(4.5, 25.5)] },
  text: { marks: TEXT },
  other: { marks: TEXT },
  // Zipper teeth hang off a center line at x=16.5, alternating right and left every 4px.
  archive: { fill: [0.5, 4.5, 8.5, 12.5, 16.5, 20.5].map((y, index) => `M16.5 ${y}h${index % 2 ? -6 : 6}a2 2 0 0 ${index % 2 ? 0 : 1} 0 4h${index % 2 ? 6 : -6}z`).join("") },
  audio: { marks: [[7.5, 12.5, 4, 16, 2], [14.5, 8.5, 4, 24, 2], [21.5, 12.5, 4, 16, 2]] },
};

export function FileGlyph({ kind }: { kind: FileGlyphKind }) {
  const { marks, fill, grid, band } = GLYPHS[kind];
  const [width, height] = kind === "slides" ? [41, 35] : [33, 41];
  return (
    // A fixed 41px slot centers portrait and landscape tiles alike, so file names line up.
    <span aria-hidden="true" className="flex w-[41px] shrink-0 justify-center">
      <span data-glyph={kind} className="relative shrink-0 overflow-hidden rounded-[6px] bg-file-card-tile" style={{ width, height }}>
        <svg className="absolute inset-0 size-full" viewBox={`0 0 ${width} ${height}`}>
          {grid && <path d={grid} className="stroke-file-card-grid" strokeWidth="0.5" fill="none" />}
          <g className="fill-file-card-line">
            {marks?.map(([x, y, w, h, r], index) => <rect key={index} x={x} y={y} width={w} height={h} rx={r} />)}
            {fill && <path d={fill} />}
          </g>
          {band && <rect y={band.top} width={width} height={height - band.top} fill={band.color} />}
        </svg>
        <span className="absolute inset-0 rounded-[6px] border-[0.5px] border-file-card-tile-edge" />
      </span>
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

/** True once the element has scrolled near the viewport, so long histories don't probe every file at once. */
function useSeen(element: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (seen || !node) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setSeen(true); }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element, seen]);
  return seen;
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
  const root = useRef<HTMLDivElement>(null);
  const visible = useSeen(root);
  const url = useWorkspaceAssetUrl(visible ? workspacePath : undefined);
  const size = useFileSize(workspacePath, url);
  return (
    <div ref={root} className="group relative flex h-[72px] w-[355px] min-w-0 max-w-full items-center gap-[10px] rounded-[18px] border-[0.5px] border-file-card-border bg-file-card-bg pr-6 pl-[15.5px]">
      <button type="button" ref={buttonRef} onClick={onOpen} aria-label={`Open ${name}`} title={name}
        className="flex min-w-0 flex-1 items-center gap-[10px] rounded-xl text-left focus-visible:outline-2 focus-visible:outline-accent">
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
