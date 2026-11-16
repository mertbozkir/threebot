import type { ReactNode } from "react";
import { FILE_CARD_COLORS, type FileGlyphKind } from "../lib/fileCards";

const BANDS: Partial<Record<FileGlyphKind, string>> = {
  pdf: FILE_CARD_COLORS.pdf,
  sheet: FILE_CARD_COLORS.sheet,
  doc: FILE_CARD_COLORS.doc,
  slides: FILE_CARD_COLORS.slides,
};

function GlyphBody({ kind }: { kind: FileGlyphKind }) {
  switch (kind) {
    case "sheet":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 32 40" aria-hidden="true">
          <g stroke="rgba(255,255,255,0.65)" strokeWidth="2" fill="none">
            <path d="M5 9h22M5 15h22M5 21h22M12 4v23M20 4v23" />
          </g>
        </svg>
      );
    case "slides":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 32 40" aria-hidden="true" fill="rgba(255,255,255,0.7)">
          <rect x="5" y="7" width="22" height="5" rx="2.5" />
          <rect x="5" y="15" width="17" height="5" rx="2.5" />
        </svg>
      );
    case "json":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 32 40" aria-hidden="true" fill="rgba(255,255,255,0.7)">
          <circle cx="7.5" cy="10" r="2" />
          <circle cx="7.5" cy="19" r="2" />
          <rect x="12" y="8" width="15" height="4" rx="2" />
          <rect x="12" y="17" width="11" height="4" rx="2" />
          <rect x="5" y="27" width="18" height="4" rx="2" />
        </svg>
      );
    case "text":
      return (
        <span className="absolute inset-x-[5px] top-[7px] flex flex-col gap-[4px]">
          <span className="h-[3px] rounded-full bg-white/70" />
          <span className="h-[3px] rounded-full bg-white/70" />
          <span className="h-[3px] rounded-full bg-white/70" />
          <span className="h-[3px] w-1/2 rounded-full bg-white/70" />
        </span>
      );
    case "archive":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 32 40" aria-hidden="true" fill="rgba(255,255,255,0.7)">
          {[6, 10, 14, 18, 22, 26, 30].map((y, index) => (
            <rect key={y} x={index % 2 ? 15 : 12} y={y} width="5" height="2.5" rx="1.25" />
          ))}
        </svg>
      );
    case "audio":
      return (
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 32 40" aria-hidden="true" fill="rgba(255,255,255,0.7)">
          <rect x="7" y="13" width="4" height="14" rx="2" />
          <rect x="14" y="9" width="4" height="22" rx="2" />
          <rect x="21" y="13" width="4" height="14" rx="2" />
        </svg>
      );
    default:
      return (
        <span className="absolute inset-x-[5px] top-[6px] flex flex-col gap-[3px]">
          <span className="h-[3px] rounded-full bg-white/70" />
          <span className="h-[3px] w-3/4 rounded-full bg-white/70" />
          <span className="h-[3px] w-1/2 rounded-full bg-white/70" />
        </span>
      );
  }
}

export function FileGlyph({ kind }: { kind: FileGlyphKind }) {
  const band = BANDS[kind];
  return (
    <span aria-hidden="true" data-glyph={kind} className="relative h-10 w-8 shrink-0 overflow-hidden rounded-md bg-[#48484a]">
      <GlyphBody kind={kind} />
      {band && <span className="absolute inset-x-0 bottom-0 h-[30%]" style={{ backgroundColor: band }} />}
    </span>
  );
}

export function FileCard({ name, detail, kind, onOpen, buttonRef, children }: {
  name: string;
  detail: string;
  kind: FileGlyphKind;
  onOpen: () => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-[72px] w-[360px] min-w-0 max-w-full items-center gap-2 rounded-[18px] border border-line bg-card pr-1.5 pl-3">
      <button type="button" ref={buttonRef} onClick={onOpen} aria-label={`Open ${name}`} title={name}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-accent">
        <FileGlyph kind={kind} />
        <span className="min-w-0">
          <span className="block truncate text-[15px] leading-5">{name}</span>
          <span className="block truncate text-[13px] leading-4 text-muted">{detail}</span>
        </span>
      </button>
      {children}
    </div>
  );
}
