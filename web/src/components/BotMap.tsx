import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import { api, type BotMapEdge } from "../lib/api";
import { botColor } from "../lib/character";
import type { Bot } from "../lib/types";
import { archivedInT3, useApp } from "../store";
import { botRole, comparePinnedBots } from "../lib/botRoles";
import { Avatar } from "./Avatar";

type Point = { x: number; y: number };

function connectionPath(from: Point | undefined, to: Point | undefined) {
  if (!from || !to) return;
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const bend = Math.min(36, length / 4) / length;
  return `M ${from.x} ${from.y} Q ${from.x + dx / 2 + dy * bend} ${from.y + dy / 2 - dx * bend} ${to.x} ${to.y}`;
}

export function BotMap({ narrow, onBack }: { narrow: boolean; onBack: () => void }) {
  const roster = useApp((s) => s.bots);
  const projects = useApp((s) => s.projects);
  const sections = useApp((s) => s.settings?.sections);
  const [edges, setEdges] = useState<BotMapEdge[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, Point>>(() => new Map());
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.botMap(controller.signal).then(({ edges }) => {
      if (!controller.signal.aborted) setEdges(edges ?? []);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  const visible = Object.values(roster).filter((bot) => !bot.hidden && !archivedInT3(bot, projects));
  const leads = visible.filter((bot) => botRole(bot)).sort(comparePinnedBots);
  const others = visible.filter((bot) => !leads.includes(bot)).sort((a, b) => a.name.localeCompare(b.name));
  const groups = new Map<string | null, Bot[]>((sections ?? []).map((name) => [name, []]));
  for (const bot of others) {
    const section = bot.section || null;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(bot);
  }
  const active = visible.find((bot) => bot.slug === (hovered ?? selected));
  const counts = new Map(visible.map((bot) => [bot.slug, { out: 0, in: 0 }]));
  const connections: BotMapEdge[] = [];
  const related = new Set<string | undefined>([active?.slug]);
  for (const edge of edges) {
    const from = counts.get(edge.from), to = counts.get(edge.to);
    if (!from || !to) continue;
    from.out += edge.count;
    to.in += edge.count;
    if (edge.from === active?.slug || edge.to === active?.slug) {
      connections.push(edge);
      related.add(edge.from);
      related.add(edge.to);
    }
  }
  // The Bot Creator looks after every Bot, so it links to the ones it hasn't messaged too.
  if (active?.creator) for (const bot of visible) if (!related.has(bot.slug)) {
    connections.push({ from: active.slug, to: bot.slug, count: 0 });
    related.add(bot.slug);
  }

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || !active) return;
    const measure = () => {
      const base = element.getBoundingClientRect();
      setPositions(new Map(Array.from(element.querySelectorAll<HTMLElement>("[data-map-avatar]"), (avatar) => {
        const rect = avatar.getBoundingClientRect();
        return [avatar.dataset.mapAvatar!, { x: rect.left - base.left + rect.width / 2, y: rect.top - base.top + rect.height / 2 }];
      })));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const panel of element.querySelectorAll("section")) observer.observe(panel);
    return () => observer.disconnect();
  }, [active, narrow, roster, projects, sections]);

  const node = (bot: Bot) => {
    const count = counts.get(bot.slug)!;
    return <button key={bot.slug} type="button" aria-pressed={selected === bot.slug}
      className={clsx("relative z-10 flex w-24 flex-col items-center gap-1 rounded-xl px-1 py-2 text-center transition-opacity focus-visible:outline-2 focus-visible:outline-accent",
        active && !related.has(bot.slug) && "opacity-25")}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovered(bot.slug); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setHovered(null); }}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setHovered(bot.slug); }}
      onBlur={() => setHovered(null)}
      onClick={() => setSelected((slug) => slug === bot.slug ? null : bot.slug)}>
      <span data-map-avatar={bot.slug} className="grid place-items-center rounded-full border border-line bg-chat p-1" style={active === bot ? { borderColor: botColor(bot.color) } : undefined}>
        <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={leads.includes(bot) ? 46 : 36} role={botRole(bot)} still />
      </span>
      <span className="text-xs leading-4">{bot.name}</span>
      <span className="text-[11px] text-muted">{count.out} out · {count.in} in</span>
    </button>;
  };

  return <section aria-label="Map" className="flex min-w-0 flex-1 flex-col bg-chat">
    <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
      <button type="button" aria-label="Back" onClick={onBack} className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-hover">
        <ArrowLeft size={20} aria-hidden="true" />
      </button>
      <h1 className="text-lg font-semibold">Map</h1>
    </header>
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5">
      <p className="mx-auto mb-5 max-w-[1200px] text-sm text-muted">
        {visible.length ? "Hover or tap a Bot to see its recent message connections." : "No Bots to show."}
      </p>
      <div ref={stage} className="relative mx-auto max-w-[1200px]">
        {active && connections.length > 0 && <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] size-full overflow-visible"
          fill="none" stroke={botColor(active.color)} strokeOpacity={0.8} strokeLinecap="round">
          {connections.map(({ from, to, count }) => <path key={`${from}:${to}`} d={connectionPath(positions.get(from), positions.get(to))} strokeWidth={count ? Math.min(7, 1 + count / 3) : 1} strokeDasharray={count ? undefined : "4 5"} />)}
        </svg>}
        {leads.length > 0 && <div className="mb-5 flex justify-center gap-10">{leads.map(node)}</div>}
        <div className={clsx("grid gap-4", narrow ? "grid-cols-1" : "grid-cols-[repeat(auto-fit,minmax(min(100%,190px),1fr))]")}>
          {[...groups].filter(([, bots]) => bots.length > 0).map(([name, bots]) =>
            <section key={name ?? ""} aria-label={name ?? "Unassigned"} className="rounded-xl border border-dashed border-line-strong p-3">
              <h2 className="mb-2 px-1 text-xs font-medium text-muted">{name ?? "Unassigned"}</h2>
              <div className="flex flex-wrap justify-center gap-1">{bots.map(node)}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  </section>;
}
