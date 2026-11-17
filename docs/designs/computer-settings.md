# Settings › Computer

Status: v1
Date: 2026-11-16
Builds on: `own-computer.md`, `desktop-host.md`

## Goal

One place to see and manage the Bots' computer, shown in Settings › Computer
while the Computer beta is on (otherwise the pane stays as it is today).

## Sections

1. **Where it runs:** This Mac / Another machine (SSH host), moved here from
   the Beta pane, plus a connection line ("Connected · Docker 28", "Can't reach
   <host> over SSH", "Apple's container isn't running", …).
2. **Your computer:** "Execution on this Mac" links to Settings › Permissions.
3. **Devices:** the machines the gateway knows (`/api/machines`), each with its
   online state, and which one runs the Bots' computer.
4. **Bot's computer:**
   - **Update Bot's computer:** rebuilds the image with fresh base packages
     (`build --pull --no-cache`), then replaces the container. Files and
     sign-ins stay (volumes); apps installed on the desktop are removed. A
     status line says "Your computer is on the latest version" when the image
     the container runs matches the current image and was built in the last 7
     days, otherwise "An update is available".
   - **Reset Bot's computer:** a confirmation dialog: "This shuts down the
     current computer and starts a fresh one. Any running work is interrupted.
     Apps and packages installed on it are removed. Your files and sign-ins
     stay." A checkbox "Also erase files and sign-ins" (off by default)
     deletes the two volumes too; the dialog then warns in red that this can't
     be undone. Buttons: Cancel / Reset Bot's computer.

Not included: Messages (no plans), routing browsing through this Mac (later).

## API

All behind the app login, only while the beta is on:

- `GET /api/computer` → `{ where: "mac"|"ssh", host?, state, reason, runtime:
  string|null /* e.g. "Docker 28.1.1" or "container 0.7" */, image: { current:
  string, running: string|null, builtAt: string|null, latest: boolean } }`
- `POST /api/computer/update` → starts the rebuild; returns the status above
  with `state: "building"`; the UI polls `GET` until it is no longer building.
- `POST /api/computer/reset` with `{ erase: boolean }` → stops and removes the
  container (and the volumes when `erase`), leaving the state `stopped`.

## Setup guides

`docs/desktop-hosts.md`: running the computer on another machine over SSH:
a homelab box on Tailscale, and a server behind Cloudflare Tunnel + Access
(`cloudflared access ssh` as `ProxyCommand` in `~/.ssh/config`, no open port).
Requirements: Docker, the user in the docker group, uid 1000.

## Acceptance

- Unit: update rebuilds with `--pull --no-cache` and recreates the container
  only after a successful build; a failed build keeps the old container;
  reset removes the container, and the volumes only with `erase`; both refuse
  while a person controls a screen (409) and wait for a running Bot batch;
  `latest` logic.
- Live: Update and Reset from the page on the real gateway (This Mac and the
  SSH host), files kept after Reset, erased with the checkbox.
