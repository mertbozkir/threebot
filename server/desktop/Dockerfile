# The Bots' shared computer: one Debian desktop with one screen per Bot. Each screen is a
# TigerVNC Xvnc display with a window manager and a bottom dock (browser, apps, terminal).
# Nothing listens on the network: each screen's VNC server is a Unix socket that the
# runtime publishes to the gateway. Outgoing traffic to private networks is blocked, and
# the desktop user has no sudo.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      tigervnc-standalone-server x11-utils x11-xserver-utils \
      xfwm4 xfconf xfce4-terminal xfce4-appfinder hsetroot \
      dbus dbus-x11 gsettings-desktop-schemas \
      chromium xdotool wmctrl scrot \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      adwaita-icon-theme hicolor-icon-theme \
      nftables procps ca-certificates curl tini; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# Fallback glyphs for Chinese, Japanese and Korean pages, and GTK for Python (the dock).
RUN apt-get update && apt-get install -y --no-install-recommends fonts-droid-fallback python3-gi python3-gi-cairo gir1.2-gtk-3.0 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    groupadd --gid 1000 bot; \
    useradd --uid 1000 --gid 1000 --create-home --home-dir /home/bot --shell /bin/bash bot; \
    mkdir -p /workspace; chown bot:bot /workspace

COPY browser /usr/local/bin/browser
COPY browser.desktop /usr/local/share/applications/browser.desktop
COPY browser-policy.json /etc/chromium/policies/managed/threebot.json
COPY dock/dock.py /usr/local/bin/desktop-dock
COPY start.sh /usr/local/bin/start-desktop
RUN chmod 0755 /usr/local/bin/browser /usr/local/bin/start-desktop /usr/local/bin/desktop-dock

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-desktop"]
