# Self-hosting

Threebot is one Node process next to a T3 Code server. It keeps everything in `THREEBOT_HOME` (default `~/.threebot`).

## Install, run and update

The installer and the `threebot` command work like T3 Code's `install.sh` and `t3`:

```sh
curl -fsSL https://raw.githubusercontent.com/RokaSwK/threebot/main/install.sh | sh
threebot up            # token from T3 Code, background service, address
threebot status        # version, service, remote access
threebot update        # newest release; rolls back if it doesn't start
threebot rollback      # the version before the last update
```

- **Releases** are GitHub release assets: `threebot-<version>.tar.gz` and `SHA256SUMS`. Pushing a `v<version>` tag that matches `package.json` builds and publishes them (`.github/workflows/release.yml`). Tags with a `-` are previews, which `threebot update --preview` installs.
- **Release notes** follow T3 Code's format, and the app shows them in Settings → Updates, in the update button's popover and after an automatic update: a header (`**v0.1.7** · 23 changes from 4 contributors`, bots not counted), up to seven highlights, `### Plus N more changes.`, and GitHub's "What's Changed" list under a "Full changelog" fold. The release workflow publishes GitHub's generated notes; to replace them, write the highlights and run the script once the tag is pushed:

  ```sh
  # highlights.md: one "- **Label.** One sentence." per line, at most 7. End a line with (#12, #14)
  # to name the PRs it covers, so they're left out of "Plus N more"; add "(beta)" where it applies.
  node scripts/release-notes.mts v0.1.6 v0.1.7 --highlights highlights.md --out notes.md
  gh release edit v0.1.7 --notes-file notes.md
  ```

  It asks GitHub (through `gh`) for the generated notes between the two tags and for each PR's author. `--target <ref>` names the commit when the new tag isn't pushed yet; `--repo owner/name` points it at another repository. Without `--highlights` the notes are the header and the full list.
- **Layout:** `~/.threebot/runtime/versions/<version>` holds each installed version, `runtime/current` links to the one running, and `runtime/previous` to the one before. `~/.local/bin/threebot` runs `current`.
- **Service:** launchd agent `tools.threebot.gateway` on macOS, systemd user unit `threebot.service` on Linux. Both run `threebot serve`, which reads `~/.threebot/.env`. Logs are in `~/.threebot/logs/`. On a headless Linux server, run `loginctl enable-linger $USER` so it keeps running after you log out. On Linux, `t3 service protect` (T3 Code 0.1.6 or newer) also keeps the T3 server alive when a Bot's commands fill the machine's memory.
- **Installer settings:** `THREEBOT_VERSION`, `THREEBOT_HOME`, `THREEBOT_INSTALL_BIN_DIR` and `THREEBOT_RELEASE_BASE_URL` (a mirror holding `v<version>/` folders).

## Keep a Bot running from a checkout

Bots only run while T3 Code and the gateway do, so run both as services on a machine that stays on. `node server/cli.mjs up` installs the same service for a checkout. Or write your own; a systemd user unit for the gateway:

```ini
[Unit]
Description=Threebot

[Service]
WorkingDirectory=%h/threebot
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=default.target
```

## Reaching it from your phone

**Settings → Remote access** sets these up in one click, and so do `threebot tailscale on` and `threebot tunnel on`:

- **Tailscale.** Threebot opens its Tailscale listener on `PORT + 1` and runs `tailscale serve --bg --https=<port>` on the first free port of 443, 8443, 8444, 8445 and 9443, leaving routes it didn't make alone. Only the Tailscale user this machine is signed in as gets in. Your tailnet needs [HTTPS certificates](https://login.tailscale.com/admin/dns) turned on. Turning it off removes only Threebot's route.
- **Cloudflare quick tunnel.** `cloudflared tunnel --protocol http2 --url http://127.0.0.1:<PORT>` gives a public `https://*.trycloudflare.com` link, with no account. It only starts once the app has a password, and the link changes each time Threebot restarts. If `cloudflared` isn't installed, Threebot downloads the same pinned version T3 Code uses, checked against its SHA-256, into `~/.threebot/tools/`. For a fixed address on your own domain, use a named tunnel with Cloudflare Access instead (below).

The password set in the app is stored as an scrypt hash in `access.json`; `BOT_PASSWORD` in `.env` takes its place if set. Changing it signs every other device out.

The default is `HOST=127.0.0.1` with no sign-in, which is only safe on your own machine. Anyone who reaches an unprotected gateway can drive your agents. Pick one before exposing it:

- **A private network.** Serve it over Tailscale or similar, so only your devices can reach it.
- **Cloudflare Access, for example with Google sign-in.** Put a Cloudflare Tunnel in front, and set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `CF_ACCESS_EMAILS`. The gateway checks the Access token on every request. [Sign in with Google through Cloudflare](cloudflare-access.md) walks through it.
- **A password.** Set `BOT_PASSWORD`, and use HTTPS in front of it.

Installing the app and receiving notifications on a phone need HTTPS.

## Connected apps

Set the `EXECUTOR_*` values in `.env` to use [Executor](https://executor.sh), self-hosted or cloud. Bots then reach your apps through it, and it holds the credentials. Without it, Bots use the browser and tokens from the Vault.

## Back up

Back up `THREEBOT_HOME`. It holds your Bots, memory and the encrypted Vault. `vault.enc` is useless without `.vault-key`, so keep the key somewhere separate and safe.

## Updating

Installed copies update from **Settings → Updates** or with `threebot update`. A checkout updates with:

```sh
git pull
npm run setup
```

Then restart the gateway. Threebot needs T3 Code 0.1.6 or later and is tested on stable releases, so update both together.

## Keep the app off the public internet

Threebot can drive agents on your machines, so don't leave it open to the internet if you can avoid it. Tailscale gives you a private address with HTTPS, so the app works as a PWA:

```sh
# in .env
TAILNET_PORT=3781
TAILNET_USERS=you@example.com
```

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3781
```

Only `tailscale serve` should reach that port, so the gateway always binds it to `127.0.0.1`, whatever `HOST` says. It sets the signed-in user on each request, and the gateway accepts no other login there. Then open `https://<machine>.<tailnet>.ts.net:8443`.

If a public host also points at the gateway, `PUBLIC_LANDING_ONLY=true` reduces that port to the landing page. Bots keep their local tool server.

If you serve the app from another address, list it in `ALLOWED_ORIGINS`. The gateway refuses WebSockets and changes that come from any other site.
