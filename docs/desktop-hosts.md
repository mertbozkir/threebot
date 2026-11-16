# The Bots' computer on another machine

Settings › Computer can run the Bots' desktop on a Linux machine you own instead of this Mac. The gateway reaches that machine over your own SSH access and asks its Docker to run the container; nothing else is installed there, and nothing listens on the network on either side.

## What the machine needs

- Linux with Docker installed.
- Your user in the `docker` group, so Docker works without sudo.
- Your user with uid 1000 (the desktop runs as uid 1000; check with `id -u`).
- SSH key login: your public key in `~/.ssh/authorized_keys` on that machine, so `ssh <host>` connects without a password prompt.

## A box at home (Tailscale or LAN)

1. Give the machine a `Host` entry in `~/.ssh/config` on this Mac:

   ```
   Host desktop
       HostName desktop.example.net
       User you
   ```

2. Check it: `ssh desktop docker info` should print Docker's details without errors.
3. In **Settings › Computer**, set **Runs on** to **Another machine** and enter `desktop`.

## A server behind Cloudflare Tunnel + Access

The server keeps no SSH port open to the internet. Cloudflare's `cloudflared access` command opens the SSH connection through the tunnel, checking you against Access first.

1. Publish the server's sshd on a tunnel hostname such as `ssh.example.com` (see [cloudflare-access.md](cloudflare-access.md) for the tunnel setup).
2. Install `cloudflared` on this Mac.
3. Route that host through Access in `~/.ssh/config`:

   ```
   Host desktop
       HostName ssh.example.com
       User you
       ProxyCommand cloudflared access ssh --hostname %h
   ```

4. Check it: `ssh desktop docker info`.
5. In **Settings › Computer**, set **Runs on** to **Another machine** and enter `desktop`.

## Good to know

- Switching where it runs stops the old desktop and starts a fresh one; files and sign-ins don't move between machines.
- The first build on a new machine takes a while. Bot calls during it are told the computer is still being prepared instead of waiting.
- If the machine is unreachable, the computer shows why ("Can't reach … over SSH", "Docker isn't running on …") and picks up again once it's back.
