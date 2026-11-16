import clsx from "clsx";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import "../mobile-settings.css";

export function IconButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        "grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function RoundButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx("grid size-[30px] place-items-center rounded-full border border-line bg-elevated/40 text-fg/80 transition-colors hover:bg-hover hover:text-fg", className)}
    >
      {children}
    </button>
  );
}

export function Pill({ variant = "primary", className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "soft" | "ghost" | "danger" }) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        "inline-flex h-[34px] shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-[14px] font-medium transition-[opacity,background] disabled:cursor-default disabled:opacity-40",
        variant === "primary" && "bg-pill text-pill-fg hover:opacity-90",
        variant === "soft" && "border border-line bg-card text-fg hover:bg-hover",
        variant === "ghost" && "text-fg hover:bg-hover",
        variant === "danger" && "bg-danger text-white hover:opacity-90",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={clsx("switch relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150", checked ? "bg-[var(--switch-on)]" : "bg-active")}
    >
      <span className={clsx("absolute top-[3px] left-0 size-[18px] rounded-full bg-white shadow-sm transition-transform duration-150", checked ? "translate-x-[19px]" : "translate-x-[3px]")} />
    </button>
  );
}

export function Modal({ onClose, onBack, children, className, title, label = "Dialog", headerActions, backIcon, backdropStyle, backdropClassName }: { onClose: () => void; onBack?: () => void; children: ReactNode; className?: string; title?: ReactNode; label?: string; headerActions?: ReactNode; backIcon?: ReactNode; backdropStyle?: CSSProperties; backdropClassName?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const elements = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]') ?? []).filter((element) => !element.matches(':disabled, [tabindex="-1"], [hidden]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    if (Array.from(document.querySelectorAll("[data-bot-modal]")).at(-1) === panel.current && !panel.current?.contains(document.activeElement)) (elements()[0] ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll("[data-bot-modal]")).at(-1) !== panel.current) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close.current(); }
      if (e.key !== "Tab") return;
      const list = elements();
      const first = list[0]; const last = list.at(-1);
      if (!first || !last) { e.preventDefault(); panel.current?.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus({ preventScroll: true }); };
  }, []);
  return createPortal(
    <div style={backdropStyle} className={clsx("bot-modal-backdrop fixed inset-0 z-50 grid place-items-center bg-[var(--overlay)] p-4", backdropClassName)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} data-bot-modal role="dialog" aria-modal="true" aria-labelledby={title !== undefined ? titleId : undefined} aria-label={title === undefined ? label : undefined} tabIndex={-1} className={clsx("pop-in flex max-h-[90vh] min-w-0 flex-col overflow-y-auto rounded-2xl border border-line bg-elevated shadow-[var(--shadow-pop)]", className)}>
        {title !== undefined && (
          <div className="bot-modal-header flex min-h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
            {onBack && <IconButton onClick={onBack} aria-label="Back">{backIcon ?? <ChevronLeft size={20} />}</IconButton>}
            <IconButton className="bot-modal-dismiss" onClick={onClose} aria-label="Close">
              <X size={16} />
            </IconButton>
            <div id={titleId} className="bot-modal-title min-w-0 flex-1 break-words text-[14px] font-semibold">{title}</div>
            {headerActions}
          </div>
        )}
        {title === undefined && <div className="bot-mobile-only-header bot-modal-header"><IconButton onClick={onClose} className="bot-modal-dismiss" aria-label="Close"><X size={16} /></IconButton><span className="bot-modal-title">{label === "Dialog" ? "" : label}</span></div>}
        {children}
      </div>
    </div>, document.body,
  );
}

export type MenuItem = { label: string; icon?: ReactNode; onSelect?: () => void; items?: MenuItem[]; danger?: boolean; detail?: string; chevron?: boolean; disabled?: boolean } | "divider";

export type MenuPoint = { clientX: number; clientY: number; preventDefault: () => void };

/**
 * A row that opens a menu: long-press on touch, right-click on a mouse. A long press swallows the
 * click, so the row does not navigate while its menu opens.
 */
export function HoldButton({ onMenu, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { onMenu: (point: MenuPoint) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const cancel = () => { clearTimeout(timer.current); };
  useEffect(() => cancel, []);
  return <button
    {...props}
    onPointerDown={(event) => {
      if (event.pointerType === "mouse" || event.button !== 0) return;
      held.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      const point = { clientX: event.clientX, clientY: event.clientY, preventDefault() {} };
      timer.current = setTimeout(() => { held.current = true; onMenu(point); }, 500);
    }}
    onPointerMove={(event) => { if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 12) cancel(); }}
    onPointerUp={cancel}
    onPointerCancel={cancel}
    onContextMenu={(event) => { event.preventDefault(); cancel(); if (!held.current) onMenu(event); }}
    onClick={(event) => { if (held.current) { held.current = false; event.preventDefault(); return; } onClick?.(event); }}
  />;
}

export function Menu({ items, onClose, x, y }: { items: MenuItem[]; onClose: () => void; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ label: string; items: MenuItem[] } | null>(null);
  const [placement, setPlacement] = useState({ left: x, top: y });
  const shown = submenu?.items ?? items;
  // The rendered height depends on the device's row size and the open submenu.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setPlacement({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) });
  }, [x, y, shown]);
  useEffect(() => {
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="app-menu pop-in fixed z-[60] min-w-[210px] rounded-xl border border-line bg-elevated p-1 shadow-[var(--shadow-pop)]" style={placement}>
      {submenu && <button role="menuitem" onClick={() => setSubmenu(null)} className="app-menu-item flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-muted hover:bg-hover"><span className="grid w-4 place-items-center opacity-80"><ChevronLeft size={14} /></span>{submenu.label}</button>}
      {shown.map((it, i) =>
        it === "divider" ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              if (it.items) return setSubmenu({ label: it.label, items: it.items });
              onClose();
              it.onSelect?.();
            }}
            className={clsx("app-menu-item flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] hover:bg-hover disabled:opacity-40", it.danger && "text-danger")}
          >
            <span className="grid w-4 place-items-center opacity-80">{it.icon}</span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.detail && <span className="shrink-0 text-muted">{it.detail}</span>}
            {(it.items || it.chevron) && <ChevronRight size={14} className="shrink-0 opacity-60" />}
          </button>
        ),
      )}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
