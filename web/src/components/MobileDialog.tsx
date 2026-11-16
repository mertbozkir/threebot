import { useEffect, useState } from "react";
import { renderSVG } from "uqr";
import { api, type AccessState } from "../lib/api";
import { mobileLink, type MobileLink } from "../lib/mobileLink";
import { openDialog, useApp } from "../store";
import { Address } from "./RemoteAccess";
import { Modal, Pill, Spinner } from "./ui";

/** Opens Settings › Remote access in place of this dialog. */
function openRemoteAccess() {
  useApp.setState({ settingsPane: "access" });
  openDialog("settings");
}

function Steps({ items }: { items: string[] }) {
  return <ol className="space-y-2">
    {items.map((text, index) => <li key={index} className="flex items-start gap-2.5 text-[13px] leading-5">
      <span aria-hidden="true" className="mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full bg-hover text-[11px] text-muted">{index + 1}</span>
      <span className="min-w-0">{text}</span>
    </li>)}
  </ol>;
}

function Qr({ url }: { url: string }) {
  // The SVG comes from uqr, generated locally from our own access URL, so its markup is trusted.
  return <div className="flex flex-col items-center gap-2">
    <div role="img" aria-label={`QR code for ${url}`} className="size-[184px] rounded-[18px] bg-white p-3 text-black [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: renderSVG(url) }} />
    <Address url={url} />
  </div>;
}

function Option({ title, badge, text, items }: { title: string; badge?: string; text: string; items: string[] }) {
  return <div className="rounded-xl border border-line p-3.5">
    <div className="flex items-center gap-2">
      <span className="text-[14px] font-medium">{title}</span>
      {badge && <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">{badge}</span>}
    </div>
    <p className="mt-1 text-[12.5px] leading-5 text-muted">{text}</p>
    <div className="mt-3"><Steps items={items} /></div>
  </div>;
}

function LinkView({ link }: { link: MobileLink }) {
  if (link.kind === "none") return <>
    <div className="min-h-0 overflow-y-auto p-4">
      <p className="text-[13px] leading-5 text-muted">Your phone needs a way to reach this Mac. Pick one.</p>
      <div className="mt-3 space-y-3">
        <Option title="Tailscale" badge="Recommended" text="Private and fixed link, free for personal use."
          items={["Install Tailscale on this Mac and your phone, same account.", "In the Tailscale admin, turn on HTTPS certificates.", "Turn on Tailscale in Remote access."]} />
        <Option title="Cloudflare link" text="No account needed. Public link behind your Threebot password; it changes on every restart."
          items={["Set a password in Remote access.", "Turn on Cloudflare link."]} />
      </div>
    </div>
    <div className="shrink-0 border-t border-line p-3">
      <Pill className="h-10 w-full" onClick={openRemoteAccess}>Open Remote access</Pill>
    </div>
  </>;
  return <div className="min-h-0 overflow-y-auto p-4">
    {link.kind === "tailscale" && <p className="mb-4 text-[13px] leading-5 text-muted">Scan with your phone's camera.</p>}
    <Qr url={link.url} />
    {link.kind === "tailscale" ? <>
      <div className="mt-4"><Steps items={["Install Tailscale on your phone and sign in with the same account.", "Scan the code and open the link.", "Share › Add to Home Screen, so it opens like an app."]} /></div>
      <p className="mt-4 text-[12.5px] leading-5 text-muted">Private: only you can open it, from devices on your tailnet. Works while this Mac is awake.</p>
      <p className="mt-2 text-[12.5px] text-muted">Can't use Tailscale on this phone? <button type="button" onClick={openRemoteAccess} className="text-accent underline-offset-2 hover:underline">Use a Cloudflare link instead</button></p>
    </> : <>
      <div className="mt-4"><Steps items={["Scan the code and sign in with your Threebot password.", "Share › Add to Home Screen."]} /></div>
      <p className="mt-4 text-[12.5px] leading-5 text-muted">Public link: anyone who has it sees the sign-in page. It changes each time Threebot restarts, so scan again then. For a fixed private link, set up Tailscale.</p>
    </>}
  </div>;
}

/** Account menu → "Get Threebot for mobile": a QR code that opens Threebot on the phone. */
export function MobileDialog() {
  const [state, setState] = useState<AccessState | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    try { setState(await api.access()); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); }
  };
  useEffect(() => { void load(); }, []);

  return <Modal title="Get Threebot for mobile" onClose={() => openDialog(null)} className="w-[420px] max-w-full">
    {!state
      ? <div className="min-h-0 overflow-y-auto p-4">
        {error
          ? <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p role="alert" className="text-[13px] text-danger">{error}</p>
            <Pill onClick={() => void load()}>Retry</Pill>
          </div>
          : <div role="status" className="grid h-24 place-items-center"><Spinner size={18} /></div>}
      </div>
      : <LinkView link={mobileLink(state)} />}
  </Modal>;
}
