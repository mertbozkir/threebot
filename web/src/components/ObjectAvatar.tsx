import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AvatarDefinition } from "open-bot-avatar";
import { mountAvatar, type MountedAvatar } from "open-bot-avatar/dom";
import { botColor, fillInk, type AvatarState } from "../lib/character";
import { objectColors, objectMood } from "../lib/objectAvatars";
import { useApp } from "../store";

// A live object is one canvas (Open Bot Avatar 0.2's default renderer) that pauses offscreen and runs
// at 30 fps when small. Only roster and hero sizes animate; list sizes stay one SVG that still
// changes pose with its mood.
const LIVE_FROM = 56;
const EYE = "var(--bot-eye-bg, var(--bg-chat))";

// Building an avatar's volume costs tens of milliseconds each (far more on a phone), and a roster holds many.
// Draw the flat silhouette at once, then build the live avatar once it is near the viewport, one per idle slice.
const pending: (() => void)[] = [];
let pumping = false;
function whenIdle(task: () => void) {
  pending.push(task);
  if (pumping) return;
  pumping = true;
  const next = () => {
    const run = () => { pending.shift()?.(); if (pending.length) next(); else pumping = false; };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 800 });
    else setTimeout(run, 16);
  };
  next();
}

function useNearViewport(element: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = element.current;
    if (near || !node) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element, near]);
  return near;
}

export function ObjectAvatar({ definition, color, size, state, still = false }: { definition: AvatarDefinition; color?: string; size: number; state: AvatarState; still?: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const live = !still && size >= LIVE_FROM;
  // A live canvas reads CSS colors itself every frame, so it follows the theme. A still one is an SVG
  // string that needs hex, resolved against the current theme.
  // Eyes are painted in the page colour, or in one derived from the fill when that would vanish into it.
  const fill = botColor(color), ink = fillInk(fill), eye = ink?.eye ?? EYE;
  const colors = () => live ? { color: fill, eyeColor: eye } : objectColors(host.current!, fill, eye);
  const options = () => ({ definition, ...colors(), mood: objectMood(state), still: !live, followPointer: live, label: "" });
  const latest = useRef(options);
  latest.current = options;
  const frame = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(frame);
  const [mounted, setMounted] = useState(false);

  // Live (roster and hero) avatars are few and in view, so they mount at once; list-size ones wait.
  useLayoutEffect(() => {
    if (!live && !near) return;
    let active = true;
    let instance: MountedAvatar | null = null;
    const mount = () => {
      if (!active || !host.current) return;
      instance = mountAvatar(host.current, latest.current());
      avatar.current = instance;
      setMounted(true);
    };
    if (live) mount(); else whenIdle(mount);
    return () => {
      active = false;
      instance?.destroy();
      avatar.current = null;
    };
  }, [live, near]);
  const theme = useApp((s) => s.settings?.theme);
  const palette = useApp((s) => s.settings?.palette);
  useLayoutEffect(() => {
    avatar.current?.update(latest.current());
    // The theme class changes in App's effect, after this one: resolve stills again once it has.
    const frame = requestAnimationFrame(() => avatar.current?.update(latest.current()));
    return () => cancelAnimationFrame(frame);
  }, [definition, color, state, live, theme, palette]);

  // The renderer draws no outline, so a fill that blends into the page gets one as a tight shadow.
  const outline = ink?.edge ? { filter: `drop-shadow(0 0 0.6px ${ink.edge}) drop-shadow(0 0 0.6px ${ink.edge})` } : undefined;
  return (
    <span ref={frame} className="relative block size-full" style={outline}>
      <span ref={host} className="block size-full" />
      {!mounted && (
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden="true">
          <path d={definition.body.path} style={{ fill }} />
          {[-1, 1].map((side) => <ellipse key={side} cx={definition.eyes.x + side * definition.eyes.spacing} cy={definition.eyes.y} rx={4.5 * (definition.eyes.scale ?? 1)} ry={6.5 * (definition.eyes.scale ?? 1)} style={{ fill: eye }} />)}
        </svg>
      )}
    </span>
  );
}
