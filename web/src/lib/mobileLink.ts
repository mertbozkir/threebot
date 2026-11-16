import type { AccessState } from "./api";

/** What the phone should open: the private Tailscale link, the public Cloudflare one, or nothing set up yet. */
export type MobileLink = { kind: "tailscale" | "cloudflare"; url: string } | { kind: "none" };

/** Tailscale wins while it is serving; a Cloudflare link stands in; neither on leaves the chooser. */
export function mobileLink(state: AccessState): MobileLink {
  const ts = state.tailscale, tunnel = state.tunnel;
  if (ts.enabled && ts.url && ts.serving !== false) return { kind: "tailscale", url: ts.url };
  if (tunnel.enabled && tunnel.url) return { kind: "cloudflare", url: tunnel.url };
  return { kind: "none" };
}
