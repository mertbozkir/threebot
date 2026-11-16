import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";

// Bundles the pure link helper (and uqr) the way the app builds them; the dialog around them is DOM work.
const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "mobile-link-test-entry",
    resolveId: (id) => id.endsWith("virtual:mobile-link") ? "\0mobile-link" : undefined,
    load: (id) => id === "\0mobile-link" ? `
      export { mobileLink } from ${JSON.stringify(`${src}lib/mobileLink.ts`)};
      export { renderSVG } from "uqr";` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:mobile-link", write: false },
});
const dir = await mkdtemp(join(tmpdir(), "bot-mobile-link-"));
const file = join(dir, "entry.mjs");
await writeFile(file, entryChunk(bundle).code);
const { mobileLink, renderSVG } = await import(pathToFileURL(file).href);
after(async () => { await rm(dir, { recursive: true, force: true }); });

// AccessState fixtures, everything off by default.
const state = (tailscale = {}, tunnel = {}) => ({
  password: { set: true, fromEnv: false },
  tailscale: { installed: true, enabled: false, fromEnv: false, users: [], ...tailscale },
  tunnel: { enabled: false, url: null, error: null, available: true, ...tunnel },
  cloudflareAccess: null,
});

test("a serving Tailscale link wins over an open Cloudflare one", () => {
  assert.deepEqual(mobileLink(state({ enabled: true, url: "https://mac.tail5678.ts.net" }, { enabled: true, url: "https://example.trycloudflare.com" })),
    { kind: "tailscale", url: "https://mac.tail5678.ts.net" });
});

test("only Cloudflare on gives the Cloudflare link", () => {
  assert.deepEqual(mobileLink(state({}, { enabled: true, url: "https://example.trycloudflare.com" })),
    { kind: "cloudflare", url: "https://example.trycloudflare.com" });
});

test("a Tailscale link that has stopped serving falls back to Cloudflare", () => {
  assert.deepEqual(mobileLink(state({ enabled: true, url: "https://mac.tail5678.ts.net", serving: false }, { enabled: true, url: "https://example.trycloudflare.com" })),
    { kind: "cloudflare", url: "https://example.trycloudflare.com" });
});

test("nothing set up leaves the chooser", () => {
  assert.deepEqual(mobileLink(state()), { kind: "none" });
});

test("the QR renderer produces SVG markup for the link", () => {
  assert.match(renderSVG("https://mac.tail5678.ts.net"), /<svg/);
});
