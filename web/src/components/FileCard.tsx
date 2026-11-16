import type { ReactNode } from "react";
import { FILE_CARD_COLORS, type FileCardAccent } from "../lib/fileCards";

export function FileGlyph({ accent }: { accent: FileCardAccent }) {
  return (
    <span aria-hidden="true" data-accent={accent} className="relative h-10 w-8 shrink-0 overflow-hidden rounded-md bg-[#48484a]">
      <span className="absolute inset-x-[5px] top-[6px] flex flex-col gap-[3px]">
        <span className="h-[3px] rounded-full bg-white/70" />
        <span className="h-[3px] w-3/4 rounded-full bg-white/70" />
        <span className="h-[3px] w-1/2 rounded-full bg-white/70" />
      </span>
      <span className="absolute inset-x-0 bottom-0 h-[30%]" style={{ backgroundColor: FILE_CARD_COLORS[accent] }} />
    </span>
  );
}

export function FileCard({ name, detail, accent, onOpen, buttonRef, children }: {
  name: string;
  detail: string;
  accent: FileCardAccent;
  onOpen: () => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-[72px] w-[360px] min-w-0 max-w-full items-center gap-2 rounded-[18px] border border-line bg-card pr-1.5 pl-3">
      <button type="button" ref={buttonRef} onClick={onOpen} aria-label={`Open ${name}`} title={name}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-accent">
        <FileGlyph accent={accent} />
        <span className="min-w-0">
          <span className="block truncate text-[15px] leading-5">{name}</span>
          <span className="block truncate text-[13px] leading-4 text-muted">{detail}</span>
        </span>
      </button>
      {children}
    </div>
  );
}
