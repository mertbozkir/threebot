# Images

## Sub-features

Open images from chat, attachments and Library; fit portrait and landscape images; zoom; close; download originals.

## How to get to it (user POV)

Open an image thumbnail in a conversation or the Library. Use the library fixture. Upload a tall PNG through the composer and send it to the synthetic Bot.

## Driving it with browser controls

Click the uploaded image attachment. Confirm the image bounds stay inside `.image-viewer-stage` at rest. Test desktop and a 390 by 844 viewport. Double-click to zoom, scroll to reset zoom, then close. Confirm the conversation returns. Save screenshots while the dialog is visible and its animation has completed.

## Gotchas

A percentage maximum height inside an implicit grid track can leave a tall image at its intrinsic size. Exercise a real portrait image. DOM tests do not measure browser layout. Chromium evidence does not prove WKWebView behavior.
