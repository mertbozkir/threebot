#!/usr/bin/env bash
# Start the shared desktop: SCREENS displays (:1..:N), each with a window manager, a
# wallpaper and a dock. Each display is a TigerVNC Xvnc server: the X server and the VNC
# server in one process, listening only on the Unix socket /tmp/vnc/N.sock (no TCP, no
# password). The runtime publishes those sockets to the gateway, which alone decides who
# may only watch and who may control. If any process dies the script exits, so the
# gateway sees a stopped container instead of a screen that silently stopped working.
set -Eeuo pipefail

SCREENS="${SCREENS:-4}"
GEOMETRY="${GEOMETRY:-1920x1200}"
LOG=/tmp/start-desktop.log

log() { printf '[desktop] %s\n' "$*" | tee -a "$LOG"; }
fail() { printf '[desktop] FATAL: %s\n' "$*" | tee -a "$LOG" >&2; exit 1; }

[[ "$SCREENS" =~ ^[1-8]$ ]] || fail "SCREENS must be 1..8"
[[ "$GEOMETRY" =~ ^[0-9]{3,4}x[0-9]{3,4}$ ]] || fail "GEOMETRY must look like 1920x1200"

# Root only prepares the volumes and the network rules, then runs the desktop as `bot`,
# which has no sudo, so nothing on the desktop can lift the rules.
if [[ "$(id -u)" == 0 ]]; then
  chown bot:bot /home/bot /workspace
  rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null || true
  mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
  install -d -o bot -g bot -m 0700 /tmp/vnc
  # A page on the desktop must not reach the host's own services, the LAN, the tailnet or
  # other containers: only DNS to the configured resolvers and the public internet.
  dns=$(awk '/^nameserver/ && $2 ~ /^[0-9.]+$/ {printf "%s%s", sep, $2; sep=", "}' /etc/resolv.conf)
  dns_rule=""
  [[ -n "$dns" ]] && dns_rule="ip daddr { $dns } meta l4proto { tcp, udp } th dport 53 accept"
  nft -f - <<NFT || fail "could not apply the network rules"
table inet desktop_egress {
  chain out {
    type filter hook output priority 0; policy accept;
    oif "lo" accept
    $dns_rule
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3 } reject
    ip6 daddr { fc00::/7, fe80::/10, ff00::/8 } reject
  }
}
NFT
  : >"$LOG"; chown bot:bot "$LOG"
  exec runuser -u bot -- env SCREENS="$SCREENS" GEOMETRY="$GEOMETRY" "$0"
fi

export HOME=/home/bot XDG_CONFIG_HOME=/home/bot/.config XDG_CACHE_HOME=/home/bot/.cache XDG_DATA_HOME=/home/bot/.local/share
export XDG_RUNTIME_DIR=/tmp/runtime-bot XDG_CURRENT_DESKTOP=XFCE XDG_SESSION_TYPE=x11
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
xfconf-query -c xfwm4 -p /general/theme -n -t string -s Default 2>/dev/null || xfconf-query -c xfwm4 -p /general/theme -s Default
xfconf-query -c xfwm4 -p /general/title_font -n -t string -s "Sans Bold 9" 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/workspace_count -n -t int -s 1 2>/dev/null || true

PIDS=()
wait_for() { local tries="$1"; shift; for ((i = 0; i < tries; i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done; return 1; }
socket_ready() { [[ -S "$1" ]]; }

start_screen() {
  local n="$1" d=":$1"
  # No clipboard in either direction: the browser's sign-ins are shared, so nothing copied on
  # the desktop may reach a viewer. Viewers can't resize the screen.
  Xvnc "$d" -geometry "$GEOMETRY" -depth 24 -dpi 96 -nolisten tcp -rfbport -1 \
    -rfbunixpath "/tmp/vnc/$n.sock" -rfbunixmode 0600 -SecurityTypes None -AlwaysShared \
    -AcceptCutText=0 -SendCutText=0 -SetPrimary=0 -SendPrimary=0 -AcceptSetDesktopSize=0 \
    >"/tmp/xvnc-$n.log" 2>&1 & PIDS+=($!)
  wait_for 50 xdpyinfo -display "$d" || fail "screen $n: X never came up: $(tail -c 300 "/tmp/xvnc-$n.log" | tr '\n' ' ')"
  wait_for 50 socket_ready "/tmp/vnc/$n.sock" || fail "screen $n: VNC socket never appeared"

  DISPLAY="$d" xfwm4 --compositor=off >"/tmp/xfwm4-$n.log" 2>&1 & PIDS+=($!)
  DISPLAY="$d" wait_for 50 wmctrl -m || fail "screen $n: window manager never answered: $(tail -c 400 "/tmp/xfwm4-$n.log" | tr '\n' ' ')"

  DISPLAY="$d" hsetroot -add "#f3f4f6" -add "#d9dde3" -add "#c6ccd4" -gradient 150 >/dev/null 2>&1 \
    || DISPLAY="$d" xsetroot -solid "#e5e7eb"

  DISPLAY="$d" desktop-dock >"/tmp/dock-$n.log" 2>&1 & PIDS+=($!)
  log "screen $n is up ($GEOMETRY)"
}

for ((n = 1; n <= SCREENS; n++)); do start_screen "$n"; done
touch /tmp/desktop-ready
log "ready: $SCREENS screens"

trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT
trap 'exit 0' TERM INT HUP
wait -n "${PIDS[@]}" || true
log "a desktop process exited; stopping"
exit 1
