import type React from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";

export function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="settings-group mb-6">
      {title && <div className="mb-2 pl-3.5 text-[13px] text-muted">{title}</div>}
      <div className="settings-card overflow-hidden rounded-[18px]">{children}</div>
    </div>
  );
}

export function Row({ title, desc, children }: { title: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="settings-row flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px]">{title}</div>
        {desc && <div className="mt-0.5 text-[13px] text-muted">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

/** Native select styled to the settings language: the chevron is decoration, keyboard behavior stays native. */
export function Select<T extends string>({ label, value, onChange, options, className }: { label: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[]; className?: string }) {
  return (
    <span className={clsx("relative inline-flex max-w-full shrink-0", className)}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => {
          const option = options.find(([v]) => v === e.target.value);
          if (option) onChange(option[0]);
        }}
        className="settings-select"
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
    </span>
  );
}
