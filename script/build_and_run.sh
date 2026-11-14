#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
case "$MODE" in
  run|--build-only|--verify) ;;
  *) echo "usage: $0 [--build-only|--verify]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--build-only|--verify]" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC_DIR="$ROOT_DIR/macos"
APP_BUNDLE="$MAC_DIR/dist/Threebot.app"
APP_CONTENTS="$APP_BUNDLE/Contents"

# Build-only does not stop or launch any process.
if [ "$MODE" != "--build-only" ]; then
  pkill -x ThreebotMac >/dev/null 2>&1 || true
fi

swift build --package-path "$MAC_DIR" --configuration release
BIN_DIR="$(swift build --package-path "$MAC_DIR" --configuration release --show-bin-path)"
mkdir -p "$APP_CONTENTS/MacOS" "$APP_CONTENTS/Resources"
cp "$BIN_DIR/ThreebotMac" "$APP_CONTENTS/MacOS/ThreebotMac"
chmod +x "$APP_CONTENTS/MacOS/ThreebotMac"

ICONSET="$MAC_DIR/.build/Threebot.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT_DIR/web/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" "$ROOT_DIR/web/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP_CONTENTS/Resources/Threebot.icns"

cat > "$APP_CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>ThreebotMac</string>
  <key>CFBundleIdentifier</key><string>tools.swk.threebot</string>
  <key>CFBundleName</key><string>Threebot</string>
  <key>CFBundleDisplayName</key><string>Threebot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleIconFile</key><string>Threebot.icns</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Threebot uses the microphone for voice input and voice chat.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Threebot turns your speech into text for voice input.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

plutil -lint "$APP_CONTENTS/Info.plist"
codesign --force --sign - "$APP_BUNDLE"
codesign --verify --strict "$APP_BUNDLE"
echo "Built $APP_BUNDLE"

if [ "$MODE" != "--build-only" ]; then
  /usr/bin/open -n "$APP_BUNDLE"
fi
if [ "$MODE" = "--verify" ]; then
  sleep 1
  pgrep -x ThreebotMac >/dev/null
  echo "ThreebotMac is running"
fi
