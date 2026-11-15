# Computer: a sandboxed desktop for Bots

Status: v3, describes what `feat/desktop-v1` builds
Date: 2026-11-16
Upstream issue: https://github.com/RokaSwK/threebot/issues/37

## Goal

Bots get their own computer. There is one sandboxed Linux desktop per user, and
each Bot drives its own screen there with computer-use tools. You can watch any
Bot's screen or take control of it. The desktop sleeps after 2 idle minutes and
keeps its files and browser sign-ins.

It is a beta switch: Settings › Beta › Computer.

## Why the preview browser isn't enough

The existing Computer view streams T3's headless browser. It has no desktop
apps, terminal windows or file dialogs; sign-ins don't persist apart from your
own browser; and some sites block automation browsers.

The desktop doesn't sandbox the agent itself. The agent still runs on the host
under T3 with its approval mode.

## Scope of v1

- macOS only, on Apple's `container` (one lightweight VM per container). If
  the CLI is missing or its service is stopped, the switch shows why.
- One shared desktop, 4 screens by default, one per Bot.
- Shared files and browser sign-ins across Bots on the same desktop.

Not in v1: Linux hosts (Docker or Podman), remote machines, typing Vault
passwords into the desktop, reclaiming screens from idle Bots.

## Design

```
web Desktop view ──/api/desktop/<bot>/vnc?mode=watch|control──┐
Bot (MCP `bot` server: computer_* tools) ─────────────────────┤
                                                gateway (server/desktop.mts)
                                                    │ `container` CLI
                                                    ▼
                                VM `threebot-desktop` (Debian 13, user `bot`)
                                Xvnc :1..:N ── Unix sockets /tmp/vnc/N.sock
                                    published to <app dir>/vnc/N.sock (0700)
```

### Image (`server/desktop/`)

- Debian 13 slim, TigerVNC `Xvnc` (X server and VNC server in one process),
  xfwm4, a small GTK dock, xfce4-terminal, Chromium, xdotool, scrot, nftables.
- Each screen is 1920x1200 with its own Chromium profile.
- The image tag is a hash of every file in `server/desktop/`, so a change
  rebuilds it.
- Resources: 1 GiB plus 512 MiB per screen, 2 CPUs.
- Volumes: `/home/bot` and `/workspace`. Files and sign-ins survive a stop.

### No network listeners

Each Xvnc listens only on a Unix socket (`-rfbport -1 -rfbunixpath`, mode
0600, no TCP). The runtime publishes the sockets into a private folder of the
gateway's app directory. Nothing on the host or LAN can reach a screen except
through the gateway.

The VNC clipboard is off in both directions, and viewers can't resize screens.

### Watch and control

The gateway proxies the browser's WebSocket to a screen's socket and filters
the RFB client stream message by message:

- **Watch** passes only pixel-format, encoding, update-request, continuous
  update and fence messages. Keys, pointer, clipboard and resize are dropped.
  Watching never wakes the desktop and doesn't count as activity.
- **Control** also passes keys and pointer. While a person controls a screen,
  the Bot's own computer calls return "The person is using your screen" and
  the desktop can't idle out.
- Unknown or oversized messages close the connection.

### Egress

`start.sh` runs as root only long enough to install nftables rules, then
drops to `bot`, which has no sudo. Pages on the desktop can reach DNS and the
public internet, but not private ranges (RFC 1918, CGNAT/tailnet, link-local,
multicast, IPv6 ULA and link-local), so they can't reach the host's services,
the LAN or other containers.

### Bot tools

On the `bot` MCP server while the beta is on. The screen is chosen by the
caller's own Bot token, never by an argument.

- `computer_screenshot`: a 1280x800 PNG of the Bot's screen. Wakes the desktop
  if needed (up to about 45 s).
- `computer_actions`: up to 20 actions in order (click, double/right click,
  move, drag, scroll, type, key, wait), then one screenshot. Coordinates are in
  1280x800 and scaled to the screen. Actions become xdotool argument lists, no
  shell.

- `computer_request_help`: the Bot asks the person to take over its screen
  for a step only they can do (sign-in, 2FA, CAPTCHA). The Desktop view shows
  a "Waiting for you" card with Take over. When the person hands the screen
  back, the gateway queues a message in the Bot's main thread.

### While someone watches or controls

- **Live pointer:** the status carries whether a batch is running and the
  Bot's last pointer position. The watch view polls faster during a batch and
  draws a dot, a click pulse and a "Using the computer" label over the screen.
- **Paste:** while in control, the person can send text that the gateway types
  into the focused window with xdotool (`POST /api/desktop/<bot>/type`, 2000
  characters, control characters refused). The VNC clipboard stays off.

### Lifecycle

States: `off | unavailable | building | stopped | starting | healthy |
stopping | failed`. One mutex orders every transition. Every CLI call has a
timeout, and after a timeout the module re-reads the real state.

- Starts on the first Bot call or on Wake in the view.
- Stops after 120 s with no Bot calls and no one in control. Before stopping
  it signals Chromium and waits briefly so cookies are written.
- A container left by an earlier gateway is replaced, not adopted.
- The gateway stops the desktop when it exits.

## Security notes

- Shared sign-ins mean a page that tricks one Bot can act with another Bot's
  logins. This is a deliberate trade-off for v1.
- A Bot can only drive its own screen. A person's control session pauses it.
- Prompt injection from pages is still possible; the egress rules limit what a
  hijacked browser can reach.

## Later PRs

1. **Hosting options:** the same desktop on another machine the person owns
   (a homelab box reached by URL and token, a Cloudflare tunnel), or on a
   sandbox provider. A small `threebot desktop-host` service next to T3 there
   would expose the same interface over HTTP.
2. **Linux hosts** with Docker or Podman.
3. **Faster wake:** suspend the VM instead of stopping it, if the runtime
   supports it.
4. **A second view for the model:** an accessibility tree or browser element
   refs next to the screenshot.

## Measured

Live run on an Apple silicon Mac with Apple `container`, 4 screens, image
already built:

| Step | Time |
|---|---|
| Cold wake to first screenshot | 9.0 s |
| Wake again after an idle stop | 7.0 s |
| Screenshot while awake | 0.11 s |
| Batch of 4 actions (with 2.5 s of waits) and screenshot | 3.4 s |

Checked in the same run: each Bot got its own screen; the VNC socket answers
only through the gateway; watch mode drops key events; a Bot call is refused
while a person controls its screen; paste typed text with a leading `-`
correctly; the hand-back message arrived in the Bot's thread; the desktop
stopped after the idle time and woke again.
