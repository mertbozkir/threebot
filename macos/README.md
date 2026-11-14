# Threebot for Mac

A small AppKit app that opens the existing Threebot website in WKWebView.
It uses the same gateway, bot data and frontend. The native window can resize,
minimize and zoom. Website data and window bounds persist between launches.

## Build and run

Requirements: macOS 14 or later and Xcode Command Line Tools with Swift 5.9 or
later. Keep the existing Threebot gateway and T3 Code running. The app opens the
gateway at the `HOST` and `PORT` in `$THREEBOT_HOME/.env` (default
`~/.threebot/.env`, which `threebot up` writes), or `http://127.0.0.1:3780/`.
It does not start or stop either service.

From the repository root:

```sh
./script/build_and_run.sh
./script/build_and_run.sh --build-only
./script/build_and_run.sh --verify
```

The script builds `macos/dist/Threebot.app`, adds the existing Threebot icon,
and signs it locally. The build targets the current Mac architecture. This is
a local build, not a notarized release. Copy the app to your Applications folder
to use it outside the checkout.

The Run action uses the same script. Cmd-R reloads, Cmd-plus and Cmd-minus zoom,
and Cmd-0 restores actual size. File inputs open a Mac chooser, and downloads ask
where to save. External links open in the default browser. Files the page opens
in a new tab, such as Open original file, get their own window; close it with
Cmd-W.

## Microphone

Voice input and voice chat use the microphone. macOS asks the first time; only
the Threebot page can use it, never the camera. If voice input says
"not-allowed", turn on Threebot in System Settings › Privacy & Security ›
Microphone.

## Notifications

WebKit in an app refuses web notification permission and has no Push API, so
the app passes the page's notifications to macOS. They arrive while the app is
open, including in the background or minimized, not after it quits. macOS asks
for permission the first time; if it never asks, or you said no, turn on
Threebot in System Settings › Notifications. Clicking one brings the window forward and opens that Bot.
