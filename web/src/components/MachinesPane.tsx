// Settings → Machines: every machine T3 links, whether it's awake, and where Bots do coding work.
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Laptop, Server } from "lucide-react";
import { api } from "../lib/api";
import type { CodingMachine, CodingWork, Machine } from "../lib/types";
import { Group, Row, Select } from "./SettingsParts";
import { Pill, Spinner } from "./ui";
import { MACHINE_STATUS, machineDot } from "./MachineBadge";
import { loadMachines, toast, useApp } from "../store";

export const LOCAL: CodingMachine = { environmentId: "local", label: "This machine" };

function ago(at: string | null) {
  if (!at) return "Never";
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes)) return "Never";
  if (minutes < 2) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

const ROUTE: Record<Machine["route"], string> = {
  local: "Threebot runs here",
  direct: "Paired: live threads, files and pictures",
  linked: "Through T3's link: read and message threads",
  none: "Link it again in T3 Code",
};

/** A machine select for "Where coding work runs": this machine, or one T3 links. */
export function MachineSelect({ label, value, onChange, machines, allowEmpty }: {
  label: string; value: CodingMachine | null; onChange: (machine: CodingMachine | null) => void; machines: Machine[]; allowEmpty?: string;
}) {
  const options: CodingMachine[] = [LOCAL, ...machines.filter((m) => !m.local).map((m) => ({ environmentId: m.environmentId, label: m.label }))];
  // A saved machine T3 no longer lists stays selectable, so the setting isn't lost without a word.
  if (value && !options.some((o) => o.environmentId === value.environmentId)) options.push({ ...value, label: `${value.label} (not linked)` });
  const pairs: (readonly [string, string])[] = options.map((o) => [o.environmentId, o.label]);
  if (allowEmpty !== undefined) pairs.unshift(["", allowEmpty]);
  return <Select label={label} className="max-w-48" value={value?.environmentId ?? ""} onChange={(id) => onChange(options.find((o) => o.environmentId === id) ?? null)} options={pairs} />;
}

/** Preferred machine, and where work goes while it's away. `inherit` adds "use the default" (per Bot). */
export function CodingWorkRows({ value, onChange, machines, inherit }: { value: CodingWork | null; onChange: (work: CodingWork | null) => void; machines: Machine[]; inherit?: string }) {
  const custom = !inherit || value !== null;
  const preferred = custom ? value?.preferred ?? LOCAL : null;
  return <>
    <Row title="Preferred machine" desc="Bots start coding work (repos, builds, tests) here when it's reachable.">
      <MachineSelect label="Preferred machine" value={preferred} machines={machines} allowEmpty={inherit}
        onChange={(machine) => onChange(machine ? { preferred: machine, fallback: machine.environmentId === LOCAL.environmentId ? null : value?.fallback ?? LOCAL } : null)} />
    </Row>
    {preferred && preferred.environmentId !== LOCAL.environmentId && <Row title="Otherwise" desc={`Where the work goes while ${preferred.label} is asleep or offline.`}>
      <MachineSelect label="Fallback machine" value={value?.fallback ?? LOCAL} machines={machines.filter((m) => m.environmentId !== preferred.environmentId)}
        onChange={(machine) => onChange({ preferred, fallback: machine ?? LOCAL })} />
    </Row>}
  </>;
}

function PairRow({ machine }: { machine: Machine }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    setBusy(true);
    try { await api.pairMachine(machine.environmentId, code.trim()); setOpen(false); setCode(""); toast(`Paired with ${machine.label}`); await loadMachines(true); }
    catch (error) { toast(error instanceof Error ? error.message : "Couldn't pair"); }
    finally { setBusy(false); }
  };
  const unpair = async () => {
    setBusy(true);
    try { await api.unpairMachine(machine.environmentId); await loadMachines(true); }
    catch (error) { toast(error instanceof Error ? error.message : "Couldn't unpair"); }
    finally { setBusy(false); }
  };
  if (machine.paired) return <Pill variant="ghost" disabled={busy} onClick={() => void unpair()}>Unpair</Pill>;
  if (machine.route === "direct") return null;
  if (!open) return <Pill variant="soft" disabled={machine.status !== "online"} onClick={() => setOpen(true)} title={machine.status === "online" ? "Show files and live threads from this machine" : "Pair while the machine is online"}>Pair</Pill>;
  return <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); void pair(); }}>
    <input aria-label={`Pairing code from ${machine.label}`} autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Pairing code" className="settings-input w-32" />
    <Pill type="submit" disabled={busy || !code.trim()}>{busy ? "Pairing…" : "Pair"}</Pill>
  </form>;
}

function MachineRow({ machine }: { machine: Machine }) {
  const Icon = machine.laptop ? Laptop : Server;
  const details = [
    machine.local ? "This machine" : machine.status === "online" ? "Seen just now" : `Last seen ${ago(machine.lastSeenAt).toLowerCase()}`,
    machine.t3Version ? `T3 Code ${machine.t3Version}` : "T3 version unknown",
    machine.threebotVersion ? `Threebot ${machine.threebotVersion}` : machine.local ? null : "No Threebot detected",
  ].filter(Boolean).join(" · ");
  return <div className="machine-row flex items-start gap-3 px-5 py-3.5" data-machine={machine.environmentId} data-machine-status={machine.status}>
    <span className="mt-0.5 grid size-8 flex-none place-items-center rounded-[10px] border border-line text-muted"><Icon size={16} /></span>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2 text-[14.5px]">
        <span className="font-medium">{machine.label}</span>
        <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px]", machine.status === "online" ? "bg-success/15 text-success" : machine.status === "asleep" ? "bg-attention/15 text-attention" : "bg-danger/15 text-danger")}>
          <span aria-hidden="true" className={clsx("size-1.5 rounded-full", machineDot(machine.status))} />{MACHINE_STATUS[machine.status]}
        </span>
      </div>
      <div className="mt-0.5 text-[12.5px] text-muted">{details}</div>
      <div className="mt-0.5 text-[12px] text-muted">{ROUTE[machine.route]}</div>
    </div>
    {!machine.local && <PairRow machine={machine} />}
  </div>;
}

export function MachinesPane({ save }: { save: (patch: { codingWork: CodingWork | null }) => Promise<boolean> }) {
  const machines = useApp((s) => s.machines);
  const settings = useApp((s) => s.settings);
  const [state, setState] = useState<{ loading: boolean; linksSupported: boolean }>({ loading: true, linksSupported: true });
  useEffect(() => { void loadMachines(true).then((result) => setState({ loading: false, linksSupported: result?.linksSupported ?? false })); }, []);
  const list = machines ?? [];
  return <>
    <p className="mb-4 text-[13px] text-muted">The computers your T3 Code links. Threads your Bots start on them open here, and Bots hear from Threebot when one goes offline mid-work.</p>
    {!state.loading && !state.linksSupported && <div role="note" className="mb-4 rounded-xl bg-active p-3.5 text-[13px] text-muted">This T3 Code doesn't share its linked machines (it needs T3 Code 0.1.9 or later). Machines in T3_ENVIRONMENTS_FILE still work.</div>}
    <Group title="Machines">
      {machines === null ? <div role="status" className="grid h-20 place-items-center"><Spinner /></div> : list.map((machine) => <MachineRow key={machine.environmentId} machine={machine} />)}
      {machines !== null && list.length === 1 && <div className="px-5 py-3.5 text-[12.5px] text-muted">No other machines yet. Link one in T3 Code (Settings → Connections → Linked environments) and it shows up here.</div>}
    </Group>
    <Group title="Where coding work runs">
      <CodingWorkRows value={settings?.codingWork ?? null} machines={list} onChange={(codingWork) => void save({ codingWork })} />
    </Group>
    <p className="text-[12.5px] text-muted">Each Bot can choose differently in its details. To pair, make a one-time code on the other machine (T3 Code → Settings → Connections, or <code>t3 auth pairing create</code>) and enter it here.</p>
  </>;
}
