# Computer on another machine

Status: v2, after three reviews (scope, failure modes, codebase fit)
Date: 2026-11-16
Builds on: `own-computer.md` (v3)

## Goal

The Bots' computer can run on another machine the person owns, such as a
Linux box at home, instead of the Mac that runs the gateway. Bots, the watch
view, Take control, ask for a hand and paste work the same; only where the
container runs changes.

## Decision: SSH, not a host service

v1 proposed a `threebot desktop-host` HTTP service on the other machine. The
reviews found that it splits state across two processes: the help hand-back
can't reach the Bot's thread from the host, control needs a new lease
protocol, the screen lease priming breaks, and the token, `tailscale serve`
setup and a funnel misconfiguration become new risks.

v2 keeps `createDesktop()` and all its state in the gateway, exactly as
today. Only the runtime commands go over SSH to the other machine:

```
gateway (Mac)                                    other machine (Linux)
 createDesktop() ── ssh <host> docker …  ──────▶ dockerd ── container threebot-desktop
 VNC proxy ──────── ssh -W <socket> <host> ────▶ /home/<user>/.threebot-desktop/vnc/N.sock
```

- One persistent SSH connection (`ControlMaster`, `ControlPersist`) carries
  every command; a command inside the desktop takes about 0.3 s.
- Each viewer gets its own `ssh -W <remote socket>` stream, which pipes the
  WebSocket straight into that screen's Unix socket. No port forwards to
  keep alive.
- Credentials are the person's own SSH key and `~/.ssh/config` host alias.
  No token, no new listener, nothing on the other machine but Docker.

## Runtime table

`server/desktop.mts` gets a runtime with the few verbs that differ:

| Verb | Apple `container` (this Mac) | Docker over SSH |
|---|---|---|
| command | `container …` | `ssh <opts> <host> -- docker …` (each argument shell-quoted) |
| health | `system status` | `info` |
| remove | `delete --force` | `rm -f` |
| running | `[0].status` | `[0].State.Status` |
| build | `build -t img <dir>` | `build -t img -` with the image folder as a tar on stdin |
| screen sockets | `--publish-socket` per screen | bind mount `<remote home>/.threebot-desktop/vnc` to `/tmp/vnc` |
| open a screen | connect to the local socket | spawn `ssh -W <remote socket> <host>` |
| hardening | VM boundary | `--cap-add NET_ADMIN`, `--security-opt no-new-privileges`, `--sysctl net.ipv6.conf.all.disable_ipv6=1` |

SSH options: `BatchMode=yes`, `ConnectTimeout=5`, `ServerAliveInterval=5`,
`ServerAliveCountMax=3`, `ControlMaster=auto`, `ControlPersist=10m`, and a
short `ControlPath` in the gateway's app folder. Every call keeps the
existing per-command timeouts, so a box that drops off the network fails a
call in seconds, not minutes.

## Settings

A top-level setting (not under `beta`, which holds only on/off switches):
`computer: { where: "mac" } | { where: "ssh", host: "<ssh alias>" }`.
Settings › Beta › Computer shows "Runs on: This Mac / Another machine (SSH
host)". Switching stops the old desktop and starts fresh on the new one;
files and sign-ins don't move.

## Failure handling

- **Unreachable:** an SSH exit 255 sets the state to `unavailable` with
  "Can't reach <host> over SSH", and the next call probes again.
- **Docker down:** "Cannot connect to the Docker daemon" sets `unavailable`
  with "Docker isn't running on <host>".
- **Socket owner:** the container's `bot` user is uid 1000. The probe checks
  `id -u` on the host. If it isn't 1000, it refuses with a clear reason.
  Mapping the uid is a later change.
- **Mid-batch drop:** the error says some actions may have run and the Bot
  should take a screenshot before retrying. Actions are never retried.
- **Slow first build:** switching to the other machine starts the build
  right away. Bot calls during `building` return at once with "The computer
  is still being prepared" instead of waiting.
- **Gateway exit:** stops the remote desktop the same way as the local one
  (`docker rm -f` over SSH, with a short timeout).
- **Two hops for VNC:** the proxy pauses the upstream when the browser's
  buffer passes 4 MiB and resumes when it drains.

## Security

- Same threat model: one person, their own machines, tailnet or LAN.
- Docker access on the other machine is root-equivalent there. That is the
  person's own choice when they add their key and the docker group.
- The RFB filter stays in the gateway, unchanged.
- Nothing listens on the network on either side.

## Measured before building

Docker 28 on a 4-core x86 laptop with Ubuntu, same image, 4 screens:

| Step | Result |
|---|---|
| Image build | 230 s, 1.07 GB |
| Container start to all screens ready | 3.5 s |
| Screenshot (exec + scrot, on the host) | 0.27 s |
| `docker exec` through a persistent SSH connection | 0.28–0.31 s |
| Memory, idle desktop | 228 MiB |

Checked: bind-mounted sockets are owned by the host user (uid 1000) with
mode 0600; `ssh -W /path/to.sock` streams into a Unix socket; nftables works
with `NET_ADMIN` and blocks private ranges while public HTTPS works.

## Acceptance

- Unit: runtime table (Docker args, quoting, state parsing, build via stdin,
  error mapping for exit 255 and daemon down), settings validation.
- Live, gateway on the Mac and Docker on a Linux box: a Bot screenshots and
  clicks; watch and Take control with real keys and pointer; paste; ask for
  a hand with the hand-back message; idle stop and wake; Wi-Fi drop while
  idle and mid-batch; switch back to This Mac.
