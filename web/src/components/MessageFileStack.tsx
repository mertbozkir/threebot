import { memo, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pause, Play } from "lucide-react";
import { FileCard as DocumentCard, FileGlyph, useFileSize, useWorkspaceAssetUrl } from "./FileCard";
import { useOpenImage, type ViewerImage } from "./ImageViewer";
import { WorkspaceFileContext } from "./WorkspaceResource";
import { workspaceLinkPath } from "../lib/workspaceLinks";
import {
  fileGlyphKind, fileTypeLabel, formatSize, mediaDuration, mediaFileKind, mediaRowTiles,
  messageFileLinks, stackPage, type MessageFileLink,
} from "../lib/fileCards";

function linkName(link: MessageFileLink): string {
  return link.text.trim() || link.path.split("/").at(-1) || link.path;
}

const WAVE_BARS = 44;

function waveBars(name: string): number[] {
  let seed = 0;
  for (let index = 0; index < name.length; index++) seed = (seed * 31 + name.charCodeAt(index)) >>> 0;
  return Array.from({ length: WAVE_BARS }, (_, index) => 4 + Math.abs((Math.sin(seed + index * 12.9898) * 43758.5453) % 1) * 16);
}

function AudioFileCard({ link }: { link: MessageFileLink }) {
  const url = useWorkspaceAssetUrl(link.path);
  const size = useFileSize(link.path, url);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const bars = useMemo(() => waveBars(linkName(link)), [link]);
  const progress = seconds ? Math.min(1, elapsed / seconds) : 0;
  const detail = [seconds !== null ? mediaDuration(seconds) : null, size !== null ? formatSize(size) : null].filter(Boolean).join(" · ") || "Audio";
  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  };
  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  };
  return (
    <div className="relative h-[120px] w-[355px] min-w-0 max-w-full rounded-[18px] border-[0.5px] border-file-card-border bg-file-card-bg pt-[15px] pr-6 pl-[15.5px]">
      <div className="flex items-center gap-[10px]">
        <FileGlyph kind="audio" />
        <span className="min-w-0">
          <span className="block truncate text-[15px] leading-5">{linkName(link)}</span>
          <span className="mt-[2px] block truncate text-[13px] leading-4 text-muted">{detail}</span>
        </span>
      </div>
      <div className="absolute right-[12.5px] bottom-2 left-[8.5px] flex h-8 items-center gap-[11px] text-muted">
        <span className="flex h-full shrink-0 items-center overflow-hidden rounded-full bg-file-card-pill">
          <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="grid h-full w-[34px] place-items-center">
            {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="ml-0.5" />}
          </button>
          <button type="button" onClick={cycleRate} aria-label="Playback speed" title="Playback speed" className="h-full w-[34px] border-l-[0.5px] border-file-card-bg text-[13px] tabular-nums">{rate}×</button>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden="true">
          {bars.map((height, index) => (
            <span key={index} className={`w-[2px] shrink-0 rounded-full ${index / WAVE_BARS < progress ? "bg-current" : "bg-file-card-wave"}`} style={{ height }} />
          ))}
        </span>
        <span className="shrink-0 text-[14px] tabular-nums">{mediaDuration(elapsed)}</span>
      </div>
      <audio ref={audio} src={url ?? undefined} preload="metadata" hidden
        onLoadedMetadata={(event) => setSeconds(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null)}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)} />
    </div>
  );
}

function MediaTile({ file, overlay }: { file: MessageFileLink; overlay: number | null }) {
  const workspace = useContext(WorkspaceFileContext);
  const name = linkName(file);
  const image = mediaFileKind(file.path) === "image";
  const url = useWorkspaceAssetUrl(file.path);
  const [duration, setDuration] = useState<number | null>(null);
  const viewerImage: ViewerImage | null = image && workspace?.threadId
    ? { key: `workspace:${file.path}`, alt: name, name, resource: { _tag: "workspace-file", threadId: workspace.threadId, path: file.path } }
    : null;
  const { ref, open, viewer } = useOpenImage(viewerImage);
  return (
    <>
      <button type="button" ref={ref} onClick={() => (image ? open() : workspace?.openFile(file.path))} aria-label={`Open ${name}`} title={name}
        className={`relative h-[102px] overflow-hidden rounded-[12px] bg-card ${image ? "w-[204px]" : "w-[136px]"}`}>
        {image
          ? url && <img src={url} alt={name} draggable={false} className="h-full w-full object-cover" />
          : <>
            <video src={url ?? undefined} preload="metadata" muted playsInline className="h-full w-full object-cover"
              onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null)} />
            <span className="absolute inset-0 grid place-items-center">
              <span className="grid size-12 place-items-center rounded-full bg-black/55 text-white"><Play size={20} fill="currentColor" className="ml-0.5" /></span>
            </span>
            {duration !== null && <span className="absolute right-2 bottom-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[12px] text-white tabular-nums">{mediaDuration(duration)}</span>}
          </>}
        {overlay !== null && <span className="absolute inset-0 grid place-items-center bg-black/45 text-[32px] font-semibold text-white">+{overlay}</span>}
      </button>
      {viewer}
    </>
  );
}

function MediaRow({ files }: { files: MessageFileLink[] }) {
  const { visible, overlay } = mediaRowTiles(files.length);
  return (
    <div className="-mt-2 flex w-full max-w-full gap-1.5">
      {files.slice(0, visible).map((file, index) => (
        <MediaTile key={file.path} file={file} overlay={overlay !== null && index === visible - 1 ? overlay : null} />
      ))}
    </div>
  );
}

function StackCard({ link }: { link: MessageFileLink }) {
  const workspace = useContext(WorkspaceFileContext);
  return <DocumentCard name={linkName(link)} detail={fileTypeLabel(link.path)} kind={fileGlyphKind(link.path)} workspacePath={link.path} onOpen={() => workspace?.openFile(link.path)} />;
}

/** The file cards of one bot message: every workspace-file link it contains, in order, under the text. */
export const MessageFileStack = memo(function MessageFileStack({ text }: { text: string }) {
  const workspace = useContext(WorkspaceFileContext);
  const [expanded, setExpanded] = useState(false);
  const resolve = useCallback((href: string) => (workspace ? workspaceLinkPath(href, workspace.workspaceRoot, workspace.fromPath) : null), [workspace]);
  const links = useMemo(() => messageFileLinks(text, resolve), [text, resolve]);
  const files = links;
  if (!workspace) return null;
  const page = stackPage(files, expanded);
  if (!page.files.length) return null;
  const rows: ReactNode[] = [];
  let media: MessageFileLink[] = [];
  const flush = () => {
    if (!media.length) return;
    rows.push(<MediaRow key={`media-${rows.length}`} files={media} />);
    media = [];
  };
  for (const file of page.files) {
    const kind = mediaFileKind(file.path);
    if (kind === "video" || kind === "image") { media.push(file); continue; }
    flush();
    rows.push(kind === "audio" ? <AudioFileCard key={file.path} link={file} /> : <StackCard key={file.path} link={file} />);
  }
  flush();
  return (
    <div className="mt-1.5 flex w-full max-w-full flex-col items-start gap-3">
      {rows}
      {page.hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="px-1 text-[13px] text-muted underline underline-offset-2 hover:text-fg">
          +{page.hidden} more files
        </button>
      )}
    </div>
  );
});
