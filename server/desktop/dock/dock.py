#!/usr/bin/python3
"""The screen's bottom dock: three launchers on a rounded pill, centred above the bottom edge.

GTK draws it only when something changes, so it costs nothing while the screen is idle. The pill's
rounded corners come from an X window shape, not transparency, so no compositor is needed.
"""
import subprocess

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402

ITEMS = [
    ("Web Browser", "chromium", ["/usr/local/bin/browser"]),
    ("Applications", "org.xfce.appfinder", ["xfce4-appfinder"]),
    ("Terminal", "org.xfce.terminal", ["xfce4-terminal"]),
]
ICON_SIZE = 48
BOTTOM_MARGIN = 8
RADIUS = 14

CSS = b"""
window { background: #eef0f3; }
box { background: transparent; padding: 4px 8px; }
button { background: transparent; border: none; box-shadow: none; padding: 4px; border-radius: 10px; }
button:hover { background: #dde1e7; }
button:active { background: #cfd4dc; }
"""


def launch(_button, command):
    subprocess.Popen(command, start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def rounded(width, height, radius):
    """A rounded rectangle as rows of rectangles, which is what an X window shape takes."""
    region = cairo.Region()
    for y in range(height):
        dy = max(radius - y - 0.5, y + 0.5 - (height - radius), 0)
        inset = round(radius - (radius * radius - dy * dy) ** 0.5) if dy else 0
        region.union(cairo.RectangleInt(inset, y, width - 2 * inset, 1))
    return region


def main():
    window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
    window.set_type_hint(Gdk.WindowTypeHint.DOCK)
    window.set_decorated(False)
    window.set_keep_above(True)
    window.stick()
    screen = window.get_screen()
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
    for name, icon, command in ITEMS:
        button = Gtk.Button()
        button.set_tooltip_text(name)
        button.add(Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.DIALOG))
        button.get_child().set_pixel_size(ICON_SIZE)
        button.connect("clicked", launch, command)
        row.pack_start(button, False, False, 0)
    window.add(row)
    window.connect("destroy", Gtk.main_quit)
    window.show_all()

    width, height = window.get_size()
    window.shape_combine_region(rounded(width, height, RADIUS))
    window.move((screen.get_width() - width) // 2, screen.get_height() - height - BOTTOM_MARGIN)
    Gtk.main()


if __name__ == "__main__":
    main()
