import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Terminal, User } from "lucide-react";
import { watchProviderData } from "../lib/providerData";
import { parseProviderUsage, peakUsage, resetsIn, limitGroups, groupUsage, totalIn, formatTokens, readBotUsage, readUsageAccounts, type BotUsage, type UsageAccounts, type ProviderUsage, type UsageLimitCard, type UsageSeries } from "../lib/usageApi";
import { Pill, Spinner } from "./ui";
import { useApp } from "../store";

/** The most-used limit across providers, for the Settings row. */
export function useUsagePeak() {
  const [peak, setPeak] = useState<number | null>(null);
  useEffect(() => watchProviderData((value) => { try { setPeak(peakUsage(parseProviderUsage(value))); } catch { setPeak(null); } }, () => setPeak(null)), []);
  return peak;
}

const dayFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (day: string) => dayFmt.format(new Date(`${day}T00:00:00Z`));
const sourceNames = { you: "You", routine: "Routines", bot: "Other Bots" };
const providerIcon = (name: string) => /codex/i.test(name) ? <Terminal size={15} strokeWidth={1.7} /> : /claude|ngc/i.test(name) ? <Sparkles size={15} strokeWidth={1.7} /> : <User size={15} strokeWidth={1.7} />;
const seriesColor = (series: UsageSeries, index: number) => series.key === "other" ? "var(--fg-faint)" : `var(--usage-s${(index % 4) + 1})`;

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <div className="usage-seg" role="group" aria-label={label}>
    {options.map(([option, text]) => <button key={option} aria-pressed={value === option} onClick={() => onChange(option)}>{text}</button>)}
  </div>;
}

function LimitCard({ card }: { card: UsageLimitCard }) {
  return <section className="usage-card">
    <h3>{card.title}</h3>
    {card.rows.map((row, index) => {
      const percent = Math.round(row.percent);
      const warn = row.percent >= 80;
      return <div className="usage-prov" key={`${row.provider}:${index}`}>
        <div className="usage-who">{providerIcon(row.provider)}{row.provider}</div>
        <div className="usage-num"><b>{percent}%</b><span>used</span></div>
        <div className={`usage-bar${warn ? " usage-bar-warn" : ""}`} role="meter" aria-label={`${row.provider} ${card.title} usage`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, Math.max(4, percent))}%` }} /></div>
        {row.resetsAt && <div className="usage-reset">{warn && <span className="usage-note">Almost used · </span>}{resetsIn(row.resetsAt)}</div>}
      </div>;
    })}
  </section>;
}

function UsageChart({ series, days }: { series: UsageSeries[]; days: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const measure = () => setWidth(box.current?.getBoundingClientRect().width || 700);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const W = width || 700, H = 200, L = 44, R = 12, B = 26, T = 8;
  const perDay = series.map((s) => days.map((_, i) => s.inp[i] + s.out[i]));
  const peak = Math.max(0, ...perDay.flat());
  const pow = 10 ** Math.floor(Math.log10(Math.max(peak, 1) / 4));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= Math.max(peak, 1) / 4) ?? 10 * pow;
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / days.length;
  const y = (v: number) => H - B - (v / max) * (H - B - T);
  const every = days.length > 10 ? 5 : 1;
  return <div className="usage-chart" ref={box} onMouseLeave={() => setHover(null)}>
    <svg role="img" aria-label="Tokens per day" viewBox={`0 0 ${W} ${H}`}>
      {Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step).map((v) => <g key={v}>
        <line className="usage-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
        <text x={L - 10} y={y(v) + 4} textAnchor="end">{formatTokens(v)}</text>
      </g>)}
      {days.map((day, i) => (i % every === 0 ? <text key={day} x={x(i)} y={H - 6} textAnchor="middle">{fmtDay(day)}</text> : null))}
      {series.map((s, k) => <g key={s.key} fill="none" stroke={seriesColor(s, k)}>
        <polyline strokeWidth={1.5} strokeLinejoin="round" points={perDay[k].map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
        {perDay[k].map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={4} fill="var(--bg-card-inner)" strokeWidth={2} />)}
      </g>)}
      {days.map((day, i) => <rect key={day} data-day={day} x={L + ((W - L - R) * i) / days.length} y={0} width={(W - L - R) / days.length} height={H - B} fill="transparent" onMouseEnter={() => setHover(i)} />)}
    </svg>
    {hover !== null && <div className="usage-tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%`, top: 4 }}>
      <b>{fmtDay(days[hover])}</b>
      {series.map((s, k) => <div className="usage-tiprow" key={s.key}>
        <span><i className="usage-sq" style={{ background: seriesColor(s, k) }} />{s.name}</span>
        <span>{formatTokens(s.inp[hover])} in · {formatTokens(s.out[hover])} out</span>
      </div>)}
    </div>}
  </div>;
}

export function UsagePanel() {
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [range, setRange] = useState<"7" | "30">("7");
  const [by, setBy] = useState<"bot" | "source" | "model">("bot");
  const [usage, setUsage] = useState<BotUsage | null>(null);
  const [usageError, setUsageError] = useState("");
  const [accounts, setAccounts] = useState<UsageAccounts | null>(null);
  const bots = useApp((s) => s.bots);
  const cards = useMemo(() => providers ? limitGroups(providers) : [], [providers]);
  const names = useMemo(() => {
    if (by === "source") return sourceNames;
    if (by === "bot") return Object.fromEntries(Object.values(bots).map((bot) => [bot.slug, bot.name]));
    return {};
  }, [by, bots]);
  const series = useMemo(() => usage ? groupUsage(usage.rows, by, names, usage.days) : [], [usage, by, names]);
  const days = usage?.days ?? [];
  const allIn = series.reduce((sum, s) => sum + s.totalIn, 0), allOut = series.reduce((sum, s) => sum + s.totalOut, 0);
  const allTokens = usage?.rows.reduce((sum, row) => sum + totalIn(row) + row.output, 0) ?? 0;
  const allCached = usage?.rows.reduce((sum, row) => sum + row.cached, 0) ?? 0;
  const cost = accounts?.accounts.reduce((sum, account) => sum + account.costUsd, 0) ?? null;
  const accountTokens = accounts?.accounts.reduce((sum, account) => sum + account.input + account.cached + account.cacheWrite + account.output, 0) ?? null;
  useEffect(() => watchProviderData((value) => { try { setProviders(parseProviderUsage(value)); setError(""); } catch { setError("Couldn't read provider limits."); } }, () => setError("Couldn't load provider limits.")), [attempt]);
  useEffect(() => {
    let live = true; setUsageError(""); setUsage(null);
    const days = range === "7" ? 7 : 30;
    readBotUsage(days).then((value) => { if (live) setUsage(value); }).catch(() => { if (live) setUsageError("Couldn't load Bot usage."); });
    readUsageAccounts(days).then((value) => { if (live) setAccounts(value); }).catch(() => { if (live) setAccounts(null); });
    return () => { live = false; };
  }, [range, attempt]);
  const retry = () => setAttempt((n) => n + 1);
  return <div className="usage-panel usage-page">
    <p className="usage-label">Limits</p>
    {error && <p role="alert">{error} <Pill variant="soft" onClick={retry}>Retry</Pill></p>}
    {!providers && !error && <Spinner />}
    <div className="usage-cards">{cards.map((card) => <LimitCard key={card.title} card={card} />)}</div>
    {providers?.length === 0 && <p>No provider limits reported.</p>}
    {providers?.map((provider) => (provider.externalUrl || provider.checkedAt) && <p className="usage-updated" key={provider.id}>
      {provider.externalUrl && <a className="usage-manage" href={provider.externalUrl} target="_blank" rel="noreferrer">Manage {provider.name} usage ↗</a>}
      {provider.checkedAt && <span>{provider.name} · Updated {new Date(provider.checkedAt).toLocaleString()}</span>}
    </p>)}

    <p className="usage-label">Bot usage</p>
    <section className="usage-card">
      {usageError ? <p role="alert">{usageError} <Pill variant="soft" onClick={retry}>Retry</Pill></p>
        : !usage ? <Spinner />
        : !usage.rows.length ? <p className="usage-empty">No Bot turns in this period yet.</p>
        : <>
          <div className="usage-top">
            <div>
              <div className="usage-big" title={cost === null ? undefined : `≈ $${cost.toFixed(2)} estimated, all use on this Mac`}>{formatTokens(allIn + allOut)} tokens</div>
              <div className="usage-sub">{formatTokens(allIn)} in · {formatTokens(allOut)} out · {allTokens ? Math.round((allCached / allTokens) * 100) : 0}% from cache · {fmtDay(usage.since)} – {fmtDay(usage.until)}</div>
              {usage.ledgerSince.slice(0, 10) > usage.since && <div className="usage-sub">Counting since {fmtDay(usage.ledgerSince.slice(0, 10))}</div>}
            </div>
            <div className="usage-segs">
              <Segmented label="Group by" value={by} options={[["source", "By source"], ["bot", "By Bot"], ["model", "By model"]]} onChange={(value) => setBy(value as typeof by)} />
              <Segmented label="Period" value={range} options={[["7", "7 days"], ["30", "30 days"]]} onChange={(value) => setRange(value as "7" | "30")} />
            </div>
          </div>
          <div className="usage-stack">{series.map((s, i) => <i key={s.key} style={{ flex: s.totalIn + s.totalOut, background: seriesColor(s, i) }} />)}</div>
          <div className="usage-legend">
            {series.map((s, i) => <div key={s.key}>
              <span className="usage-sq" style={{ background: seriesColor(s, i) }} />
              <span className="usage-name">{s.name}</span>
              <span className="usage-vals">{formatTokens(s.totalIn)} in · {formatTokens(s.totalOut)} out</span>
            </div>)}
          </div>
          <UsageChart series={series} days={days} />
          {accountTokens !== null && <p className="usage-accounts">Bots: {formatTokens(allIn + allOut)} of {formatTokens(accountTokens)} tokens on {accounts!.accounts.length} {accounts!.accounts.length === 1 ? "account" : "accounts"} in this period</p>}
        </>}
    </section>
  </div>;
}
