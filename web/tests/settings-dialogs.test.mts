import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import { buildOnce, domWindow, entryChunk, isModule } from "./support.mts";
import { MessageChannel } from "node:worker_threads";
import avatarConfig from "../../server/avatar-config.json" with { type: "json" };
import { fileURLToPath } from "node:url";

// React act's browser fallback creates Node message ports in this bundled test.
// Track and close them after the suite so the runner can exit normally.
const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() { super(); channels.push(this); }
};

// Real React DOM, generic fixtures, and no live server or browser. happy-dom has
// no layout engine: the CSS test proves declared constraints, not device layout.
const window = domWindow(new Window({ url: "http://settings.test", width: 390, height: 844, settings: { device: { prefersReducedMotion: "reduce" } } }));
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "IntersectionObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Layout stand-in: visible elements have one 32×32 box (happy-dom does no layout).
window.HTMLElement.prototype.getClientRects = function (this: HTMLElement) { return (this.hidden ? [] : [{ width: 32, height: 32 }]) as unknown as DOMRectList; };
const src = fileURLToPath(new URL("../src/", import.meta.url));
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "settings-dialog-test-entry", resolveId: (id) => id.endsWith("virtual:settings-tests") ? "\0settings-tests" : undefined,
    load: (id) => id === "\0settings-tests" ? `
      export { createElement, act, useState } from "react";
      export { createRoot } from "react-dom/client";
      export { SkillsDialog } from ${JSON.stringify(`${src}components/SkillsDialog.tsx`)};
      export { t3 } from ${JSON.stringify(`${src}lib/t3.ts`)};
      export { parseVaultCsv, parseCsv } from ${JSON.stringify(`${src}lib/vaultCsv.ts`)};
      export { SettingsDialog } from ${JSON.stringify(`${src}components/SettingsDialog.tsx`)};
      export { AvatarPicker, NewBotDialog, RenameBotDialog } from ${JSON.stringify(`${src}components/NewBotDialog.tsx`)};
      export { AvatarEditorDialog } from ${JSON.stringify(`${src}components/AvatarEditor.tsx`)};
      export { createCharacter } from ${JSON.stringify(`${src}lib/character.ts`)};
      export { AvatarPlayer } from ${JSON.stringify(`${src}components/avatarPlayer.ts`)};
      export { AvatarDialog } from ${JSON.stringify(`${src}components/Details.tsx`)};
      export { Modal } from ${JSON.stringify(`${src}components/ui.tsx`)};
      export { useApp } from ${JSON.stringify(`${src}store.ts`)};` : undefined,
    transform: (code, id) => isModule(id, `${src}components/Details.tsx`) ? { code: `${code}\nexport { AvatarDialog };`, map: null } : undefined }],
  ssr: { noExternal: true }, build: { ssr: "virtual:settings-tests", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const testDir = await mkdtemp(join(tmpdir(), "bot-settings-tests-"));
const testEntry = join(testDir, "components.mjs");
await writeFile(testEntry, entry.code);
const { parseVaultCsv, parseCsv, createElement: h, act, useState, createRoot, SettingsDialog, SkillsDialog, t3, AvatarPicker, NewBotDialog, RenameBotDialog, AvatarEditorDialog, AvatarDialog, Modal, useApp, createCharacter, AvatarPlayer } = await import(pathToFileURL(testEntry).href);
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } await window.happyDOM.close(); await rm(testDir, { recursive: true }); });
let root, host, requests, settings, handleRequest;
beforeEach(() => {
  requests = [];
  settings = { userName: "Person", theme: "system", accent: "bot", timezone: "", autoReview: true, rules: { alwaysAsk: ["Ask before buying"], allowWithoutAsking: [] }, sections: [], defaultModel: null };
  handleRequest = async (url, init) => {
    if (url === "/api/settings") { if (init.method === "PUT") settings = { ...settings, ...JSON.parse(init.body) }; return Response.json(settings); }
    if (url === "/api/executor") return Response.json({ configured: false });
    if (url === "/api/vault") return Response.json({ items: [] });
    if (url === "/t3/.well-known/t3/environment") return Response.json({ label: "Test computer", serverVersion: "1.2.3", orchestrationProtocolVersion: 2 });
    throw new Error(`Unexpected request: ${url}`);
  };
  globalThis.fetch = async (url, init = {}) => { requests.push({ url, ...init }); return handleRequest(url, init); };
  useApp.setState({ settingsPane: "overview", settings, vault: null, bots: {}, threads: {}, providers: [], connection: "open", botsRoot: "/example/bots" });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const render = async (element = h(SettingsDialog)) => act(async () => root.render(element));
const click = async (el) => { assert.ok(el, "control exists"); await act(async () => el.click()); };
const button = (text, scope: ParentNode = document) => [...scope.querySelectorAll("button")].find((el) => el.textContent.trim() === text);
// Controls by accessible name; pass the element type when the test reads more than HTMLElement has.
const labeled = <T extends Element = HTMLElement,>(label, scope: ParentNode = document) => scope.querySelector<T>(`[aria-label="${label}"]`);
const key = async (el, key, extra = {}) => act(async () => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
const input = async (el, value) => act(async () => {
  const prototype = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true })); el.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const select = async (label, value) => act(async () => { const el = labeled<HTMLSelectElement>(label); el.value = value; el.dispatchEvent(new window.Event("change", { bubbles: true })); });

for (const [label, pane] of [["General", "general"], ["Computer", "computer"], ["Permissions", "permissions"], ["Vault", "vault"], ["Updates", "updates"]]) test(`${label} opens its category and Back returns to overview`, async () => {
  await render(); await click(button(label, document.querySelector("nav")));
  assert.equal(useApp.getState().settingsPane, pane); assert.ok(document.body.textContent.includes(label));
  await click(labeled("Back")); assert.equal(useApp.getState().settingsPane, "overview"); assert.ok([...document.querySelectorAll("button")].some((button) => button.textContent.startsWith("Appearance")));
});

test("Connect apps is nested and Back preserves the Settings overview", async () => {
  await render(); await click(button("Connect appsSearch plugins"));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 2); assert.match(document.body.textContent, /Apps aren't set up yet/);
  await click(labeled("Back", [...document.querySelectorAll('[role="dialog"]')].at(-1)));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1); assert.equal(useApp.getState().settingsPane, "overview");
});

test("General saves theme, accent, timezone and trimmed name through real PUTs", async () => {
  useApp.setState({ settingsPane: "general" }); await render();
  useApp.setState({ settingsPane: "appearance" }); await render(); await click(button("Dark")); await click(button("Black"));
  useApp.setState({ settingsPane: "general" }); await render(); await select("Timezone", "UTC");
  const name = labeled<HTMLInputElement>("Your name"); await act(async () => name.focus()); await input(name, "  New person  "); await act(async () => name.blur());
  assert.equal(settings.theme, "dark"); assert.equal(settings.accent, "black"); assert.equal(settings.timezone, "UTC"); assert.equal(settings.userName, "New person");
  await act(async () => root.unmount()); root = createRoot(host); useApp.setState({ settings }); await render();
  assert.equal(labeled<HTMLInputElement>("Your name").value, "New person"); assert.equal(useApp.getState().settings.theme, "dark"); assert.equal(labeled<HTMLSelectElement>("Timezone").value, "UTC");
  assert.equal(requests.filter((r) => r.method === "PUT").length, 4);
});

test("failed save shows status and retains the permission rule draft", async () => {
  useApp.setState({ settingsPane: "permissions" }); let rejectRequest;
  handleRequest = (url, init) => init.method === "PUT"
    ? new Promise((resolve) => { rejectRequest = () => resolve(Response.json({ error: "Storage unavailable" }, { status: 503 })); })
    : Response.json(settings);
  await render(); await click(button("Add Rule")); await input(document.querySelector("#permission-rule"), "Ask before deleting"); await click(button("Add rule"));
  assert.match(document.querySelector('[role="status"]').textContent, /Saving/); assert.equal(document.querySelector("fieldset").disabled, true);
  await act(async () => rejectRequest()); assert.match(document.querySelector('[role="alert"]').textContent, /Storage unavailable/);
  assert.equal(document.querySelector<HTMLInputElement>("#permission-rule")!.value, "Ask before deleting"); assert.equal(document.querySelector("fieldset").disabled, false);
});

test("permission add/edit/delete and Approvals save their values, editing inline", async () => {
  useApp.setState({ settingsPane: "permissions" }); await render(); await select("Approvals", "full"); assert.equal(settings.autoReview, false);
  await click(button("Add Rule")); await input(document.querySelector("#permission-rule"), "Ask before deleting"); assert.equal(document.querySelectorAll("[data-bot-modal]").length, 1); await click(button("Add rule"));
  assert.deepEqual(settings.rules.alwaysAsk, ["Ask before buying", "Ask before deleting"]);
  await click(labeled("Edit rule")); await input(document.querySelector("#permission-rule"), "Ask before spending"); await click(button("Save"));
  assert.deepEqual(settings.rules.alwaysAsk, ["Ask before spending", "Ask before deleting"]);
  await click(labeled("Delete rule")); assert.deepEqual(settings.rules.alwaysAsk, ["Ask before deleting"]);
});

test("Escape cancels the rule editor without closing Settings", async () => {
  useApp.setState({ settingsPane: "permissions", dialog: "settings" }); await render(); await click(button("Add Rule")); await key(document.querySelector("#permission-rule"), "Escape");
  assert.equal(document.querySelector("#permission-rule"), null); assert.equal(useApp.getState().dialog, "settings"); assert.equal(requests.length, 0);
});

test("Computer/Updates report metadata and retry a genuine failure", async () => {
  useApp.setState({ settingsPane: "computer", connection: "closed" }); handleRequest = async () => Response.json({ error: "Offline" }, { status: 503 }); await render();
  assert.match(document.body.textContent, /Disconnected/); assert.match(document.body.textContent, /Couldn't load computer information/); assert.doesNotMatch(document.body.textContent, /Reconnecting|undefined/);
  handleRequest = async () => Response.json({ label: "Test computer", serverVersion: "1.2.3", orchestrationProtocolVersion: 2 }); await click(button("Retry"));
  assert.match(document.body.textContent, /Test computer/); assert.match(document.body.textContent, /T3 Code 1.2.3/);
  await click(button("Updates", document.querySelector("nav"))); assert.match(document.body.textContent, /Server 1.2.3 · protocol 2/);
});

test("Vault retries, exposes supported types and saves a nested contact", async () => {
  useApp.setState({ settingsPane: "vault" }); handleRequest = async () => Response.json({ error: "Offline" }, { status: 503 }); await render();
  assert.match(document.body.textContent, /Couldn't load Vault/); assert.ok([...document.querySelectorAll("button")].some((button) => button.textContent.startsWith("Payments")));
  handleRequest = async (url, init) => init.method === "POST" ? Response.json({ id: "contact-1", ...JSON.parse(init.body), createdAt: "2026-01-01", updatedAt: "2026-01-01" }) : Response.json({ items: [] });
  await click(button("Retry")); const trigger = button("New item"); await act(async () => trigger.focus()); await click(trigger);
  const contactAction = button("Contact info"); await act(async () => contactAction.focus()); await click(contactAction);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
  const sheet = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  await input([...sheet.querySelectorAll("label")].find((el) => el.textContent === "Full name").querySelector("input"), "Example person"); assert.equal(button("Save contact info", sheet).disabled, true); await input([...sheet.querySelectorAll("label")].find((el) => el.querySelector('input[type="email"]')).querySelector("input"), "person@example.com"); await click(button("Save contact info", sheet));
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1); assert.equal(useApp.getState().vault[0].name, "Example person"); assert.ok(document.activeElement === trigger, "closing the contact form restores focus to New item");
});

test("Modal portals outside transformed parents, traps focus and closes only the nested layer", async () => {
  const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  function Nested() { const [inner, setInner] = useState(false); return h("section", { style: { transform: "translateX(160px)" } }, h(Modal, { title: "Outer", onClose: () => assert.fail("outer must stay open") }, h("button", { onClick: () => setInner(true) }, "Open inner"), inner && h(Modal, { title: "Inner", onClose: () => setInner(false) }, h("button", null, "Last action")))); }
  await render(h(Nested)); assert.equal(document.querySelector('[data-bot-modal]').parentElement.parentElement, document.body);
  const opener = button("Open inner"); await act(async () => opener.focus()); await click(opener);
  const inner = [...document.querySelectorAll('[data-bot-modal]')].at(-1), first = labeled("Close", inner), last = button("Last action", inner);
  await act(async () => last.focus()); await key(last, "Tab"); assert.equal(document.activeElement, first); await key(first, "Tab", { shiftKey: true }); assert.equal(document.activeElement, last);
  await key(last, "Escape"); assert.equal(document.querySelectorAll('[data-bot-modal]').length, 1); assert.equal(document.activeElement, opener);
  await act(async () => root.unmount()); root = createRoot(host); assert.equal(document.activeElement, trigger);
});

test("AvatarPicker returns chosen identity and disables saves while busy", async () => {
  const changes = []; await render(h(AvatarPicker, { shape: "sphere", color: "teal", onChange: (...value) => changes.push(value) }));
  const shape = document.querySelector('.avatar-shapes button[aria-pressed="false"]'), nextShape = shape.getAttribute("aria-label").replace(/ shape$/, "");
  await click(shape); await click(labeled("blue")); assert.deepEqual(changes, [[nextShape, "teal"], ["sphere", "blue"]]);
  await render(h(AvatarPicker, { shape: "sphere", color: "teal", disabled: true, onChange: () => assert.fail("disabled picker must not save") })); await click(labeled("blue"));
});

const avatarBot = { slug: "example", name: "Example", shape: "sphere", color: "teal", projectId: null, mainThreadId: "example-main" };
test("T3 is the final unlabeled grid tile and keeps the color palette visible", async () => {
  let saved = { ...avatarBot };
  useApp.setState({ bots: { example: saved } });
  handleRequest = async (url, init) => {
    if (url === "/api/bots/example" && init.method === "PUT") {
      saved = { ...saved, ...JSON.parse(init.body) }; return Response.json(saved);
    }
    if (url === "/api/bots") return Response.json({ bots: [saved] });
    throw Error(`Unexpected request ${url}`);
  };
  await render(h(AvatarDialog, { bot: saved, onClose() {} }));
  await click(labeled("T3 avatar"));
  assert.equal(labeled("T3 avatar").getAttribute("aria-pressed"), "true");
  assert.ok(document.querySelector(".avatar-colors"));
  assert.equal(labeled("T3 avatar").parentElement.lastElementChild, labeled("T3 avatar"));
  assert.equal(labeled("T3 avatar").querySelector("text"), null);
  assert.equal(labeled("T3 avatar").querySelectorAll(":scope > span").length, 1);
  assert.equal(requests.length, 0);
  await click(button("Done"));
  assert.equal(saved.shape, "t3"); assert.equal(saved.color, "teal");
  await act(async () => root.unmount()); root = createRoot(host);
  await render(h(AvatarDialog, { bot: saved, onClose() {} }));
  assert.equal(labeled("T3 avatar").getAttribute("aria-pressed"), "true");
  await click(labeled("cloud shape"));
  assert.ok(document.querySelector(".avatar-colors"));
  await click(labeled("blue")); await click(button("Done"));
  assert.equal(saved.shape, "cloud"); assert.equal(saved.color, "blue");
});

test("a custom colour previews live while it is picked and is saved, and remembered, only with Done", async () => {
  let saved = { ...avatarBot };
  useApp.setState({ bots: { example: saved } });
  handleRequest = async (url, init) => {
    if (url === "/api/bots/example" && init.method === "PUT") { saved = { ...saved, ...JSON.parse(init.body) }; return Response.json(saved); }
    if (url === "/api/bots") return Response.json({ bots: [saved] });
    throw Error(`Unexpected request ${url}`);
  };
  localStorage.removeItem("bot.avatar.recentColors");
  await render(h(AvatarDialog, { bot: saved, onClose() {} }));
  const custom = labeled("Custom colour");
  assert.equal(custom.parentElement.lastElementChild, custom, "the custom swatch comes after the presets");
  assert.equal(custom.getAttribute("aria-expanded"), "false");
  await click(custom);
  const area = labeled("Saturation and brightness"), hue = labeled("Hue");
  const hex = document.querySelector<HTMLInputElement>(".color-picker-hex input");
  const fill = () => document.querySelector<SVGSVGElement>(".avatar-editor-preview svg").querySelector("path[mask], g[data-figure] > path").getAttribute("fill");
  assert.equal(hex.value, avatarConfig.colors.teal.slice(1).toUpperCase(), "starts from the current colour");
  // Keyboard: Home on the hue is red, End on the area is full saturation, PageUp full brightness.
  await key(hue, "Home"); await key(area, "End"); await key(area, "PageUp");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  assert.equal(hex.value, "FF0000");
  assert.equal(fill(), "#ff0000", "the big preview follows");
  assert.equal(labeled("Custom colour #FF0000").getAttribute("aria-pressed"), "true");
  // Typing six digits applies; three apply on Enter; a bad value reverts on blur.
  await input(hex, "3fa7d6");
  assert.equal(fill(), "#3fa7d6");
  await input(hex, "zz"); await act(async () => { hex.dispatchEvent(new window.FocusEvent("blur", { bubbles: false })); hex.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })); });
  assert.equal(hex.value, "3FA7D6");
  // Pasting "#rgb" anywhere in the picker.
  await act(async () => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: { getData: () => string } };
    event.clipboardData = { getData: () => " #F3A ", files: [] } as never;
    area.dispatchEvent(event);
  });
  assert.equal(hex.value, "FF33AA");
  assert.equal(requests.length, 0, "nothing is saved while picking");
  assert.equal(localStorage.getItem("bot.avatar.recentColors"), null, "nor remembered");
  await click(button("Done"));
  assert.equal(saved.color, "#ff33aa");
  assert.deepEqual(JSON.parse(localStorage.getItem("bot.avatar.recentColors")), ["#ff33aa"]);
  await act(async () => root.unmount()); root = createRoot(host);
  await render(h(AvatarDialog, { bot: saved, onClose() {} }));
  assert.equal(labeled("Custom colour #FF33AA").getAttribute("aria-pressed"), "true");
  await click(labeled("Custom colour #FF33AA"));
  assert.equal(labeled("#ff33aa").getAttribute("aria-pressed"), "true", "a recent colour");
  // A picked colour that is exactly a swatch is stored by its name.
  const field = document.querySelector<HTMLInputElement>(".color-picker-hex input");
  await input(field, avatarConfig.pickerColors.find((c) => c.id === "blue").value);
  assert.equal(labeled("blue").getAttribute("aria-pressed"), "true");
  // Except black, whose swatch turns white in dark mode: a picked #000000 stays black.
  await input(field, "000000");
  assert.equal(labeled("black").getAttribute("aria-pressed"), "false");
  assert.equal(labeled("Custom colour #000000").getAttribute("aria-pressed"), "true");
  // Escape cancels a half-typed value instead of committing it.
  await act(async () => field.focus());
  await input(field, "abc");
  await key(field, "Escape");
  assert.equal(field.value, "000000");
  assert.ok(labeled("Custom colour #000000"));
});

test("near-white and near-black fills get an outline, painted eyes and visible ink in each theme", () => {
  for (const [fill, light, dark] of [["#fbf9f2", true, false], ["#15131c", false, true], ["#39ff14", true, false]] as const) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    document.body.append(svg);
    const character = createCharacter(svg, { shape: "ball", state: "idle", fill, size: 64 });
    const { body, eyes } = character.parts();
    const stroke = body.getAttribute("stroke");
    assert.match(stroke, /^light-dark\(/, `${fill}: outline`);
    assert.equal(stroke.startsWith("light-dark(transparent"), !light, `${fill}: outline in light`);
    assert.equal(stroke.endsWith("transparent)"), !dark, `${fill}: outline in dark`);
    assert.equal(svg.querySelector("mask"), null, `${fill}: eyes are painted`);
    for (const eye of eyes) assert.match(eye.style.fill, /light-dark\(/);
    assert.match(svg.style.getPropertyValue("--fg"), /light-dark\(/, `${fill}: overlay ink`);
    character.destroy(); svg.remove();
  }
  // A mid colour keeps cut-out eyes and no outline.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  document.body.append(svg);
  const character = createCharacter(svg, { shape: "ball", state: "idle", fill: "#3fa7d6", size: 64 });
  assert.equal(character.parts().body.getAttribute("stroke"), "none");
  assert.ok(svg.querySelector("mask"));
  assert.equal(svg.style.getPropertyValue("--fg"), "#3fa7d6");
  character.destroy(); svg.remove();
});

test("T3 plays every engine state, folding into a glowing planet with sky-toned glyphs", () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  host.append(svg);
  const character = createCharacter(svg, { shape: "t3", fill: "#ffffff", state: "idle", size: 184 });
  try {
    const scene = svg.querySelector('[data-avatar-skin="t3"]');
    const before = scene.outerHTML;
    for (let i = 0; i < 60; i++) character.step(1 / 60);
    assert.notEqual(scene.outerHTML, before);
    const glow = () => Number(svg.querySelector('[data-layer="planet-glow"]').getAttribute("opacity"));
    assert.equal(glow(), 0, "the full face has no planet glow");
    assert.match(svg.style.getPropertyValue("--fg"), /^url\(#/, "engine glyphs use the sky gradient");
    assert.ok(svg.querySelectorAll("[data-t3-fx]").length >= 2, "engine effects are scoped for recolouring");
    assert.match(svg.querySelector("defs style").textContent, /\[data-t3-fx\] stop/);
    const expressions = new Map();
    for (const state of Object.values(avatarConfig.states)) {
      character.setState(state, { resetEyes: true });
      for (let i = 0; i < 60; i++) character.step(1 / 60);
      const { eyes } = character.parts();
      assert.equal(eyes.length, 2);
      for (const eye of eyes) assert.equal(eye.getAttribute("fill"), "#ffffff");
      expressions.set(state, eyes.map(eye => eye.outerHTML).join(" "));
      assert.doesNotMatch(svg.outerHTML, /NaN|Infinity|undefined/, state);
      if (["thinking", "radar", "orbit", "progress"].includes(state)) assert.ok(glow() > 0.4, `${state} folds into the planet`);
    }
    for (const state of ["sleeping", "thinking", "happy", "alerting"]) {
      assert.notEqual(expressions.get(state), expressions.get("idle"), `${state} must change the expression`);
    }
  } finally { character.destroy(); }
});

test("reduced-motion T3 stays still and switching editions cleans up the skin and eye masks", () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  host.append(svg);
  // A mid fill: a near-white one paints its eyes instead of cutting them out.
  const props = { shape: "t3", fill: "#1084fe", state: "idle", size: 184 };
  const player = new AvatarPlayer(svg, props);
  try {
    assert.equal(player.wantsFrames(), false);
    assert.ok(svg.querySelector('[data-avatar-skin="t3"]'));
    const before = svg.outerHTML;
    player.refresh(); assert.equal(svg.outerHTML, before);
    player.update({ ...props, shape: "leaf" });
    assert.equal(svg.querySelector('[data-avatar-skin="t3"]'), null);
    assert.equal(svg.querySelectorAll("mask path[fill=black]").length, 2);
    player.update({ ...props, state: "sleeping" });
    assert.equal(svg.querySelectorAll('[data-avatar-skin="t3"]').length, 1);
    assert.equal(svg.querySelectorAll("mask").length, 0);
    assert.equal(player.wantsFrames(), false);
  } finally { player.destroy(); }
  assert.equal(svg.children.length, 0);
});

const t3Scene = (state = "idle", size = 184) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); host.append(svg);
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 184, height: 184 }) as DOMRect;
  const character = createCharacter(svg, { shape: "t3", fill: "#A97EFE", state, size });
  return {
    svg, character,
    advance(seconds) { for (let i = 0; i < seconds * 60; i++) character.step(1 / 60); },
    opacity: name => Number(svg.querySelector(name).getAttribute("opacity")),
  };
};

test("T3 puffs billow independently, the pointer ploughs a wake, and clouds spring back", () => {
  const resting = t3Scene(), following = t3Scene();
  const position = (svg, name) => svg.querySelector(`[data-puff="${name}"]`).getAttribute("transform").match(/translate\(([-.\d]+) ([-.\d]+)\)/).slice(1).map(Number);
  const puffs = [...resting.svg.querySelectorAll<SVGElement>("[data-puff]")].map(el => el.dataset.puff);
  const before = puffs.map(name => position(resting.svg, name));
  const fieldsBefore = [...resting.svg.querySelectorAll('[data-layer^="stars-"]')].map(el => el.getAttribute("opacity"));
  const stepBoth = seconds => { resting.advance(seconds); following.advance(seconds); };
  try {
    // Aimed at the near bank's largest lobe, left of the valley.
    following.character.setGazeTarget({ x: 37, y: 140 }); stepBoth(1.5);
    const displacements = puffs.map((name, i) => position(resting.svg, name).map((v, axis) => (v - before[i][axis]).toFixed(2)).join(","));
    assert.ok(new Set(displacements).size === puffs.length, "every puff must move on its own");
    assert.notDeepEqual([...resting.svg.querySelectorAll('[data-layer^="stars-"]')].map(el => el.getAttribute("opacity")), fieldsBefore);
    const shift = name => Math.hypot(...position(following.svg, name).map((v, axis) => v - position(resting.svg, name)[axis]));
    assert.ok(shift("near-3") > 2, "a puff under the pointer is pushed aside");
    assert.ok(shift("near-3") > shift("near-4") * 2, "the wake is local to the pointer");
    following.character.setGazeTarget(null); stepBoth(3);
    for (const name of puffs) assert.ok(shift(name) < 0.05, `${name} returns to rest after the pointer leaves`);
  } finally { resting.character.destroy(); following.character.destroy(); }
});

test("T3 cloud banks share one soft crest per layer and idle has no comet", () => {
  const { svg, character, advance, opacity } = t3Scene();
  try {
    advance(6);
    assert.equal(opacity("[data-comet]"), 0);
    for (const bank of ["far", "middle", "near"]) {
      const puffs = svg.querySelectorAll(`[data-layer="clouds-${bank}"] [data-puff]`);
      assert.equal(new Set([...puffs].map(el => el.getAttribute("fill"))).size, 1, `${bank} bank uses one crest`);
    }
  } finally { character.destroy(); }
});

test("T3 raises an aurora behind the clouds while busy and clears it afterwards", () => {
  const { svg, character, advance, opacity } = t3Scene("working");
  const curtain = () => svg.querySelector("[data-curtain]").getAttribute("d");
  try {
    advance(2);
    assert.ok(opacity('[data-layer="aurora"]') > 0.4);
    const before = curtain();
    advance(0.5);
    assert.notEqual(curtain(), before, "the hems ripple");
    assert.doesNotMatch(curtain(), /NaN/);
    const layers = [...svg.querySelector('[data-avatar-skin="t3"]').children].map(el => (el as SVGElement).dataset.layer);
    for (const bank of ["clouds-far", "clouds-middle", "clouds-near"]) {
      assert.ok(layers.indexOf("aurora") < layers.indexOf(bank), "the aurora stays behind every cloud");
      assert.ok(layers.indexOf("comet") < layers.indexOf(bank), "the comet stays behind every cloud");
    }
    assert.ok(opacity("[data-comet]") > 0.5, "the comet is out while working");
    assert.ok(svg.querySelector('[data-layer="comet"] polyline').getAttribute("points").length > 0, "the comet leaves a trail");
    character.setState("idle", { resetEyes: true }); advance(4);
    assert.equal(svg.querySelector('[data-layer="aurora"]').getAttribute("display"), "none");
  } finally { character.destroy(); }
});

test("T3 weather follows the mood: sleep tide, storm lightning and celebration", () => {
  const { svg, character, advance, opacity } = t3Scene();
  const tide = () => Number(svg.querySelector('[data-layer="clouds-near"]').getAttribute("transform").match(/translate\([-.\d]+ ([-.\d]+)\)/)[1]);
  const glow = () => opacity('[data-layer="sky-glow"]');
  try {
    character.setState("celebrate", { resetEyes: true }); advance(2.4);
    assert.ok([...svg.querySelectorAll("[data-meteor]")].some(el => Number(el.getAttribute("opacity")) > 0));
    const bright = glow(), open = tide();
    character.setSize(32); assert.equal(svg.querySelector('[data-layer="meteors"]').getAttribute("display"), "none");
    character.setSize(184); assert.equal(svg.querySelector('[data-layer="meteors"]').getAttribute("display"), "inline");
    character.setState("sleeping", { resetEyes: true }); advance(5);
    assert.ok(glow() < bright * 0.7, "sleep gradually dims the sky");
    assert.ok(tide() > open + 20, "clouds rise like a blanket");
    assert.ok(opacity('[data-layer="moon"]') > 0.5, "the moon comes out");
    assert.ok([...svg.querySelectorAll("[data-meteor]")].every(el => el.getAttribute("opacity") === "0"));
    character.setState("alerting", { resetEyes: true });
    let strongest = 0, flashes = 0, previous = 0;
    for (let i = 0; i < 480; i++) {
      character.step(1 / 60);
      const flash = opacity('[data-layer="lightning"]');
      if (flash > 0.5 && previous <= 0.5) flashes++;
      strongest = Math.max(strongest, flash); previous = flash;
    }
    assert.ok(strongest > 0.5, "the storm strikes");
    assert.ok(flashes <= 6, "lightning stays under three flashes per second");
    assert.ok(opacity('[data-layer="overcast"]') > 0.5);
    character.holdFrame(); const held = svg.outerHTML;
    advance(2); assert.equal(svg.outerHTML, held, "neither ambient layers nor facial animation advance in a held frame");
    assert.equal(opacity('[data-layer="lightning"]'), 0);
    assert.equal(opacity("[data-comet]"), 0);
  } finally { character.destroy(); }
});

test("small T3 avatars only light the rim for trouble and drop the fine detail", () => {
  const busy = t3Scene("working", 28), angry = t3Scene("angry", 28), calm = t3Scene("idle", 28), folded = t3Scene("thinking", 28);
  const arc = scene => scene.svg.querySelector("[data-status-arc]");
  try {
    for (const scene of [busy, angry, calm, folded]) scene.advance(2);
    assert.equal(arc(busy).getAttribute("opacity"), "0", "busy states act out the work instead of spinning a ring");
    assert.ok(Number(arc(angry).getAttribute("opacity")) > 0.5);
    assert.equal(arc(angry).getAttribute("stroke"), "#ff6b7d");
    assert.equal(arc(calm).getAttribute("opacity"), "0");
    assert.equal(arc(folded).getAttribute("opacity"), "0", "folded states already show their own glyph");
    assert.equal(busy.svg.querySelector('[data-layer="aurora"]').getAttribute("display"), "none");
    assert.equal(busy.svg.querySelector('[data-layer="clouds-far"]').getAttribute("display"), "none");
  } finally { for (const scene of [busy, angry, calm, folded]) scene.character.destroy(); }
});

test("profile avatar choices stay local until Done, while Cancel and Escape discard them", async () => {
  let closes = 0;
  useApp.setState({ bots: { example: avatarBot } });
  await render(h(AvatarDialog, { bot: avatarBot, onClose: () => closes++ }));
  assert.equal(button("Done").disabled, false);
  await click(labeled("blue"));
  assert.equal(labeled("blue").getAttribute("aria-pressed"), "true");
  assert.equal(button("Done").disabled, false);
  assert.equal(requests.length, 0); assert.equal(useApp.getState().bots.example.color, "teal");
  await click(labeled("Back")); assert.equal(closes, 1); assert.equal(requests.length, 0);
  await key(labeled("blue"), "Escape"); assert.equal(closes, 2); assert.equal(requests.length, 0);
});

test("profile avatar Done publishes the confirmed choice and keeps failures retryable", async () => {
  let closes = 0, fail = true, saved = { ...avatarBot };
  useApp.setState({ bots: { example: avatarBot } });
  handleRequest = async (url, init) => {
    if (url === "/api/bots/example" && init.method === "PUT") {
      if (fail) return Response.json({ error: "Avatar storage unavailable" }, { status: 503 });
      saved = { ...saved, ...JSON.parse(init.body) }; return Response.json(saved);
    }
    if (url === "/api/bots") return Response.json({ bots: [saved] });
    throw Error(`Unexpected request ${url}`);
  };
  await render(h(AvatarDialog, { bot: avatarBot, onClose: () => closes++ }));
  await click(labeled("blue")); await click(button("Done"));
  assert.match(document.querySelector('[role="alert"]').textContent, /Avatar storage unavailable/);
  assert.equal(closes, 0); assert.equal(labeled("blue").getAttribute("aria-pressed"), "true");
  assert.equal(useApp.getState().bots.example.color, "teal"); assert.equal(button("Done").disabled, false);
  fail = false; await click(button("Done"));
  assert.equal(closes, 1); assert.equal(useApp.getState().bots.example.color, "blue");
  assert.deepEqual(requests.filter(request => request.method === "PUT").map(request => JSON.parse(request.body)), [{ shape: "sphere", color: "blue", avatarImage: null }, { shape: "sphere", color: "blue", avatarImage: null }]);
});

// Three drawn looks with distinct bodies, so the preview's outline says which one it shows.
const look = (id, name, path) => ({ version: 1, id, name, body: { path }, eyes: { x: 50, y: 50, spacing: 15, scale: 1 } });
const savedLook = look("own-saved", "Saved", "M32 12 C56 6 86 16 88 42 C90 68 72 90 48 90 C24 90 10 72 12 50 C14 30 18 16 32 12 Z");
const drawnLooks = [look("drawn-1", "Tall", "M50 10 C72 10 88 22 88 38 L82 42 C84 68 70 90 50 90 C30 90 16 68 18 42 L12 38 C12 22 28 10 50 10 Z"), look("drawn-2", "Round", "M50 14 C74 14 90 30 90 54 C90 76 74 88 50 88 C26 88 10 76 10 54 C10 30 26 14 50 14 Z")];
test("the editor previews the selected drawing on the left, with one selection and open eyes", async () => {
  const style = document.createElement("style"); style.textContent = await readFile(new URL("../src/components/avatar-editor.css", import.meta.url), "utf8"); document.head.append(style);
  try {
    const initial = { shape: "object:own-saved", color: "brown", avatarImage: null, avatarDefinition: savedLook };
    const drawing = { description: "a cat", options: drawnLooks.map((definition) => ({ status: "ready", definition })) };
    let closed = 0;
    await render(h(AvatarEditorDialog, { initial, shared: [savedLook], draw: { drawing, start() {}, retry() {}, discard() {} }, onSave: async () => assert.fail("nothing is saved without Use or Done"), onClose: () => { closed++; } }));
    // Each look's scene carries an id made from its outline.
    const scene = (el) => el.querySelector("[data-avatar-scene]").getAttribute("data-avatar-scene");
    const preview = () => scene(document.querySelector(".avatar-editor-preview"));
    const selected = () => [...document.querySelectorAll('.avatar-drawn [aria-pressed="true"]')].map((el) => el.getAttribute("aria-label"));
    const show = async (definition) => { const probe = document.createElement("div"); document.body.append(probe); const r = createRoot(probe);
      await act(async () => r.render(h(AvatarEditorDialog, { initial: { ...initial, shape: `object:${definition.id}`, avatarDefinition: definition }, onSave: async () => {}, onClose() {} })));
      const html = scene([...document.querySelectorAll(".avatar-editor-preview")].at(-1)); await act(async () => r.unmount()); probe.remove(); return html; };
    const [saved, tall, round] = [await show(savedLook), await show(drawnLooks[0]), await show(drawnLooks[1])];
    assert.notEqual(saved, tall); assert.notEqual(tall, round);
    // A finished drawing is the one selection, and the big avatar shows it.
    assert.deepEqual(selected(), ["Option 1 of 2: Tall"]);
    assert.equal(preview(), tall);
    await click(labeled("Option 2 of 2: Round"));
    assert.deepEqual(selected(), ["Option 2 of 2: Round"]);
    assert.equal(preview(), round);
    // Picking the saved look moves the one selection back to it.
    await click(labeled("Saved"));
    assert.deepEqual(selected(), ["Saved"]);
    assert.equal(preview(), saved);
    await click(labeled("Option 1 of 2: Tall"));
    assert.equal(preview(), tall);
    // The small preview rests with open eyes, cut out in an opaque surface colour, never the translucent hover tint.
    const card = document.querySelector(".avatar-draw-preview");
    assert.equal(card.querySelector("[data-avatar-state]").getAttribute("data-avatar-state"), "idle");
    assert.doesNotMatch(style.textContent.match(/\.avatar-draw-preview \{[^}]*\}/)[0], /--bot-eye-bg/);
    for (const [, value] of style.textContent.matchAll(/--bot-eye-bg:\s*([^;}]+)/g)) assert.doesNotMatch(value, /--bg-(hover|active)/);
    await click(labeled("Close"));
    assert.equal(closed, 1);
  } finally { style.remove(); }
});

// On a phone, Bot details show Edit, which opens Edit Bot; its avatar editor must offer drawing too.
test("Edit Bot's avatar editor offers Draw a new object and names the drawing model, which Change opens in Settings", async () => {
  const luna = { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, status: "ready", models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna" }] };
  useApp.setState({ bots: { example: { ...avatarBot, projectId: "project-example" } }, providers: [luna], dialog: { kind: "rename-bot", slug: "example" } });
  await render(h(RenameBotDialog, { slug: "example" }));
  await click(labeled("Edit Bot avatar"));
  const editor = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  assert.match(editor.textContent, /Drawn by your Bots/);
  await click(labeled("Draw a new object", editor));
  assert.ok(labeled("Describe the new object", editor));
  assert.match(editor.querySelector(".avatar-draw-model").textContent, /^Drawn with GPT-6 Luna · Change$/);
  await click(button("Change", editor));
  assert.equal(useApp.getState().dialog, "settings");
  assert.equal(useApp.getState().settingsPane, "models");
});

test("the Settings overview leads to Models, where the avatar drawing model is chosen", async () => {
  await render();
  await click([...document.querySelectorAll("button")].find((el) => el.textContent.startsWith("Models")));
  assert.equal(useApp.getState().settingsPane, "models");
  assert.match(document.body.textContent, /Avatar drawing model/);
  assert.match(document.body.textContent, /Default model/);
  assert.match(document.body.textContent, /Draws the avatars you describe in a Bot's avatar editor/);
  await click(labeled("Back")); assert.equal(useApp.getState().settingsPane, "overview");
});

test("computed dialog/grid constraints fit phone and landscape widths", async () => {
  const style = document.createElement("style"); style.textContent = await readFile(new URL("../src/mobile-settings.css", import.meta.url), "utf8") + await readFile(new URL("../src/components/avatar-editor.css", import.meta.url), "utf8"); document.head.append(style);
  try {
    await render(h(Modal, { title: "Avatar", onClose: () => {} }, h(AvatarPicker, { shape: "sphere", color: "teal", onChange: () => {} })));
    for (const [width, height, safeLeft, safeRight] of [[320, 568, 0, 0], [360, 640, 0, 0], [390, 844, 0, 0], [412, 915, 0, 0], [844, 390, 44, 44]]) {
      window.happyDOM.setWindowSize({ width, height });
      await render(h(Modal, { key: width, title: "Avatar", onClose: () => {}, className: "w-[440px] max-w-full" }, h(AvatarPicker, { shape: "sphere", color: "teal", onChange: () => {} })));
      const panel = document.querySelector('[data-bot-modal]'), grid = getComputedStyle(document.querySelector(".avatar-shapes"));
      assert.ok(getComputedStyle(panel).maxWidth === "100%" || getComputedStyle(panel).maxWidth.includes(`${width}px`), "sheet is constrained to the viewport"); assert.equal(getComputedStyle(panel.parentElement).gridTemplateColumns, "minmax(0, 1fr)"); assert.equal(grid.justifyContent, "center");
      assert.equal(grid.gridTemplateColumns, "repeat(10, minmax(0, 1fr))");
      assert.ok(getComputedStyle(panel).maxHeight === "100%" || getComputedStyle(panel).maxHeight.includes("100dvh"));
    }
  } finally { style.remove(); window.happyDOM.setWindowSize({ width: 390, height: 844 }); }
});

test("Connect apps distinguishes request failure from unconfigured state", async () => {
  handleRequest = async () => Response.json({ error: "Service unavailable" }, { status: 503 });
  await render(); await click(button("Connect appsSearch plugins"));
  assert.match(document.body.textContent, /Couldn't load apps/);
  assert.doesNotMatch(document.body.textContent, /Apps aren't set up yet/);
  handleRequest = async () => Response.json({ configured: false });
  await click(button("Retry")); assert.match(document.body.textContent, /Apps aren't set up yet/);
});

test("app search keeps the current filter when the complete catalog arrives", async () => {
  let resolveCatalog;
  handleRequest = async (url) => {
    if (url === "/api/executor") return Response.json({ configured: true, hasToken: true, connections: [] });
    if (url.endsWith("search=")) return new Promise((resolve) => { resolveCatalog = resolve; });
    throw new Error(`Unexpected request: ${url}`);
  };
  await render(); await click(button("Connect appsSearch plugins"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  assert.equal(typeof resolveCatalog, "function");
  await input(labeled("Search apps"), "new");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  await act(async () => resolveCatalog(Response.json({ entries: [
    { id: "old", name: "Old result", description: "Other app", icon: null, auth: [] },
    { id: "new", name: "New result", description: "Current search", icon: null, auth: [] },
  ] })));
  assert.match(document.body.textContent, /New result/); assert.doesNotMatch(document.body.textContent, /Old result/);
});

test("catalog failures offer Retry search without claiming no matches", async () => {
  handleRequest = async (url) => url === "/api/executor" ? Response.json({ configured: true, hasToken: true, connections: [] }) : Response.json({ error: "Catalog unavailable" }, { status: 503 });
  await render(); await click(button("Connect appsSearch plugins"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  assert.match(document.body.textContent, /Couldn't search apps/); assert.doesNotMatch(document.body.textContent, /No results match/);
  handleRequest = async () => Response.json({ entries: [] }); await click(button("Retry search"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  assert.match(document.body.textContent, /No apps are available right now/); assert.doesNotMatch(document.body.textContent, /Couldn't search apps/);
  await input(labeled("Search apps"), "sample");
  assert.match(document.body.textContent, /No results match/);
});

test("Vault token toggle edits the form without submitting it", async () => {
  useApp.setState({ settingsPane: "vault" }); await render(); await click(button("New item")); await click(button("Login"));
  const sheet = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  const website = [...sheet.querySelectorAll("label")].find((el) => el.textContent.startsWith("Website")).querySelector("input");
  await input(website, "https://example.test"); await click(labeled("API token or key"));
  assert.equal(labeled("API token or key").getAttribute("aria-checked"), "true");
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 2);
  await key(labeled("API token or key"), "Escape");
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
});


test("New Bot keeps a live draft avatar and disables creation for empty or whitespace names", async () => {
  useApp.setState({ bots: { existing: { slug: "existing" } } });
  await render(h(NewBotDialog));
  const create = button("Create"), name = labeled("Name your Bot");
  assert.equal(create.disabled, true);
  await input(name, "   "); assert.equal(create.disabled, true);
  await input(name, "New lab Bot"); assert.equal(create.disabled, false);
  assert.equal(document.querySelectorAll(".new-bot-sheet > .dialog-body .avatar-shapes button").length,14);
  await click(labeled("Edit Bot avatar"));
  await click(document.querySelector('.avatar-editor-sheet [aria-label="blue"]')); assert.equal(document.querySelector('.avatar-editor-sheet [aria-label="blue"]').getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelectorAll(".avatar-editor-sheet .avatar-shapes button").length, 14);
  assert.equal(document.querySelectorAll(".avatar-editor-sheet .avatar-colors button").length, 12, "eleven swatches and the custom one");
  assert.equal(requests.length, 0, "editing the draft has no external writes");
});

test("Payments reports its unsupported boundary and never offers card entry", async () => {
  useApp.setState({ settingsPane: "vault" }); await render();
  await click([...document.querySelectorAll("button")].find((button) => button.textContent.startsWith("Payments")));
  assert.match(document.body.textContent, /Saving cards requires a secure payment provider/);
  assert.equal(document.querySelector('input[autocomplete="cc-number"]'), null);
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
});


test("a late workspace skill refresh cannot replace the next Bot's skills", async () => {
  const originalCall = t3.call, originalStream = t3.stream;
  let finishRefresh;
  t3.stream = () => ({ cancel() {}, done: Promise.resolve(), live: () => false });
  const provider = (name) => ({ providers: [{ instanceId: "codex", displayName: "Codex", skills: [{ name, enabled: true }] }] });
  t3.call = async (tag) => tag === "server.refreshProviders" ? new Promise((resolve) => { finishRefresh = resolve; }) : provider(useApp.getState().selected === "a" ? "skill-a" : "skill-b");
  try {
    const bot = (slug) => ({ slug, workspaceRoot: `/${slug}`, model: { instanceId: "codex", model: "example" } });
    useApp.setState({ bots: { a: bot("a"), b: bot("b") }, selected: "a" });
    await render(h(SkillsDialog, { onClose() {} })); await click(button("Refresh workspace skills"));
    await act(async () => { useApp.setState({ selected: "b" }); });
    assert.match(document.body.textContent, /skill-b/);
    await act(async () => { finishRefresh(provider("stale-a")); });
    assert.match(document.body.textContent, /skill-b/); assert.doesNotMatch(document.body.textContent, /stale-a/);
  } finally { t3.call = originalCall; t3.stream = originalStream; }
});

test("Account and manual Time Zone open separate destinations, while automatic zone disables its picker", async () => {
  await render();
  document.querySelector(".settings-content").scrollTop = 210;
  await click(button("PPersonAccount"));
  assert.equal(useApp.getState().settingsPane, "account");
  assert.ok(labeled("Your name")); assert.equal(labeled("Timezone"), null);
  await click(labeled("Back"));
  assert.equal(document.querySelector(".settings-content").scrollTop, 210);
  const timeZone = [...document.querySelectorAll("button")].find((button) => button.textContent.startsWith("Time Zone"));
  assert.equal(timeZone.disabled, true);
  await act(async () => { useApp.setState({ settings: { ...settings, timezone: "UTC" } }); });
  await click([...document.querySelectorAll("button")].find((button) => button.textContent.startsWith("Time Zone")));
  assert.equal(useApp.getState().settingsPane, "timezone");
  await select("Time Zone", "Europe/Paris"); assert.equal(settings.timezone, "Europe/Paris");
});

test("Always Ask and Allow without Asking use their distinct editor examples and Cancel closes them", async () => {
  useApp.setState({ settingsPane: "permissions" }); await render();
  const add = () => [...document.querySelectorAll("button")].filter((button) => button.textContent.trim() === "Add Rule");
  await click(add()[0]); assert.equal(document.querySelector<HTMLInputElement>("#permission-rule")!.placeholder, "Purchases over $50");
  await click(button("Cancel")); assert.equal(document.querySelector("#permission-rule"), null);
  await click(add()[1]); assert.equal(document.querySelector<HTMLInputElement>("#permission-rule")!.placeholder, "Emails to my team at acme.com"); assert.equal(button("Add rule").disabled, true);
  await click(button("Cancel"));
  assert.equal(document.querySelector("#permission-rule"), null); assert.equal(document.querySelectorAll('[role="dialog"]').length, 1); assert.equal(requests.length, 0);
});

test("Sign Out uses the real logout route, suppresses duplicate clicks and retains Settings on failure", async () => {
  let finish;
  handleRequest = (url) => { if (url === "/api/config") return Response.json({ botsRoot: "/bots" }); assert.equal(url, "/api/logout"); return new Promise((resolve) => { finish = resolve; }); };
  await render(); const signOut = button("Sign Out"); await click(signOut); await click(signOut);
  assert.equal(requests.filter((request) => request.url === "/api/logout").length, 1); assert.equal(button("Signing out…").disabled, true);
  await act(async () => { finish(Response.json({ error: "Unavailable" }, { status: 503 })); });
  assert.ok(button("Sign Out")); assert.equal(button("Sign Out").disabled, false); assert.equal(useApp.getState().settingsPane, "overview");
});


test("older shapes outside the picker stay in the preview and reset clears the picture and identity", async () => {
  const bot = { ...avatarBot, shape: "cylinder", color: "amber", avatarImage: "/api/bots/example/avatar/" + "a".repeat(64) + ".png" };
  useApp.setState({ bots: { example: bot } });
  await render(h(AvatarDialog, { bot, onClose() {} }));
  assert.equal(document.querySelector(".avatar-editor-preview img").getAttribute("src"), bot.avatarImage);
  assert.equal(labeled("cylinder shape"), null);
  await click(button("Reset"));
  assert.equal(document.querySelector(".avatar-editor-preview img"), null);
  assert.ok(document.querySelector('.avatar-shapes button[aria-pressed="true"]'));
  assert.equal(labeled("violet").getAttribute("aria-pressed"), "true");
  assert.equal(requests.length, 0);
});

test("the preview keeps an older silhouette and color without selecting a substitute tile", async () => {
  await render(h(AvatarDialog, { bot: { ...avatarBot, shape: "cylinder", color: "amber" }, onClose() {} }));
  assert.equal(document.querySelector('.avatar-shapes [aria-pressed="true"]'), null);
  assert.equal(document.querySelector('.avatar-colors [aria-pressed="true"]'), null);
  const svg = document.querySelector<SVGSVGElement>('.avatar-editor-preview svg');
  assert.match(svg.querySelector('path[mask]').getAttribute('d'), /^M/);
  assert.equal(svg.style.getPropertyValue('--fg'), avatarConfig.colors.amber);
  assert.equal(requests.length, 0);
});


test("Vault repeated websites add, remove, and submit all explicit sites", async () => {
  useApp.setState({ settingsPane: "vault" });
  handleRequest = async (url, init) => url === "/api/vault" && init.method === "POST" ? Response.json({id:"sample-login",...JSON.parse(init.body)}) : Response.json({items:[]});
  await render(); await click(button("New item")); await click(button("Login"));
  const fields = () => [...document.querySelectorAll<HTMLInputElement>('.vault-repeated-website input')];
  await input(fields()[0], "https://first.invalid");
  await click(button("Add website"));
  await input(fields()[1], "https://second.invalid");
  await click(button("Add website"));
  await input(fields()[2], "https://remove.invalid");
  await click([...document.querySelectorAll('.vault-repeated-website .vault-repeated-actions button')].at(-1));
  assert.equal(fields().length, 2);
  assert.equal(requests.filter(request=>request.method==='POST').length,0,"add/remove do not submit");
  await click(button("Save"));
  const saved = useApp.getState().vault[0];
  assert.deepEqual(saved.websites,["https://first.invalid","https://second.invalid"]);
  assert.equal(saved.website,"https://first.invalid");
});

test("Vault repeated phones and emails make primary, remove and save ordered values", async () => {
  useApp.setState({ settingsPane: "vault" });
  handleRequest = async (url, init) => url === "/api/vault" && init.method === "POST" ? Response.json({id:"sample-contact",...JSON.parse(init.body)}) : Response.json({items:[]});
  await render(); await click(button("New item")); await click(button("Contact info"));
  for (const [kind,add,values] of [["phone","Add phone",["+15555550101","+15555550102"]],["email","Add email",["first@example.invalid","second@example.invalid"]]]) {
    const fields = () => [...document.querySelectorAll<HTMLInputElement>(`.vault-repeated-${kind} input`)];
    await input(fields()[0],values[0]); await click(button(add)); await input(fields()[1],values[1]);
    await click(button("Make primary",document.querySelector(`.vault-repeated-${kind}`)));
    assert.deepEqual(fields().map(field=>field.value),[values[1],values[0]]);
  }
  await click(button("Remove",document.querySelector('.vault-repeated-phone')));
  assert.equal(requests.filter(request=>request.method==='POST').length,0);
  await click(button("Save contact info"));
  const saved = useApp.getState().vault[0];
  assert.deepEqual(saved.phones,["+15555550102"]); assert.equal(saved.phone,"+15555550102");
  assert.deepEqual(saved.emails,["second@example.invalid","first@example.invalid"]); assert.equal(saved.email,"second@example.invalid");
});

test("Computer pane (beta on): the Runs on choice and SSH host save through settings", async () => {
  settings.beta = { projects: false, desktop: true };
  handleRequest = async (url, init) => {
    if (url === "/api/settings") { if (init.method === "PUT") settings = { ...settings, ...JSON.parse(init.body) }; return Response.json(settings); }
    if (url.startsWith("/api/computer")) return Response.json({ where: "mac", state: "stopped", reason: null, runtime: null, image: { current: "img-7", running: "img-7", builtAt: null, latest: true } });
    if (url.startsWith("/api/machines")) return Response.json({ machines: [{ environmentId: "local", label: "Test computer", local: true, status: "online", lastSeenAt: null, t3Version: "1.2.3", threebotVersion: "0.1.9", laptop: true, route: "local", paired: false, lastError: null }], linksSupported: true });
    throw new Error(`Unexpected request: ${url}`);
  };
  useApp.setState({ settingsPane: "computer", settings, machines: null }); await render();
  assert.equal(labeled<HTMLSelectElement>("Runs on").value, "mac");
  assert.match(document.body.textContent, /Bot's computer · Sleeping/);
  await select("Runs on", "ssh");
  const host = labeled<HTMLInputElement>("SSH host");
  assert.equal(host.placeholder, "a host from your ~/.ssh/config");
  await input(host, "build-box");
  await click(button("Save"));
  assert.deepEqual(settings.computer, { where: "ssh", host: "build-box" });
  handleRequest = (url, init) => init.method === "PUT"
    ? Response.json({ error: "computer.where must be \"mac\" or \"ssh\"" }, { status: 400 })
    : Response.json(settings);
  await input(labeled<HTMLInputElement>("SSH host"), "other-box");
  await click(button("Save"));
  assert.match(document.querySelector('[role="alert"]').textContent, /must be "mac" or "ssh"/);
  assert.deepEqual(settings.computer, { where: "ssh", host: "build-box" });
  handleRequest = async (url, init) => {
    if (url === "/api/settings") { if (init.method === "PUT") settings = { ...settings, ...JSON.parse(init.body) }; return Response.json(settings); }
    if (url.startsWith("/api/computer")) return Response.json({ where: "mac", state: "stopped", reason: null, runtime: null, image: { current: "img-7", running: "img-7", builtAt: null, latest: true } });
    if (url.startsWith("/api/machines")) return Response.json({ machines: [], linksSupported: true });
    throw new Error(`Unexpected request: ${url}`);
  };
  await select("Runs on", "mac");
  assert.deepEqual(settings.computer, { where: "mac" });
});

test("Bot CSV import retains ordered repeatable fields and skips malformed arrays", () => {
  const csvCell=value=>'"'+value.replaceAll('"','""')+'"';
  const websites=["https://first.invalid","https://second.invalid"];
  const login=parseVaultCsv('name,url,username,password,note,websites\nSample,https://first.invalid,user,synthetic,, '+csvCell(JSON.stringify(websites)).trimStart()+'\n');
  assert.deepEqual(login.items[0].websites,websites);
  const contacts=parseVaultCsv('label,name,email,phone,street,kind,emails,phones\nHome,Sample,first@example.invalid,111,,home,'+csvCell(JSON.stringify(["first@example.invalid","second@example.invalid"]))+','+csvCell(JSON.stringify(["111","222"]))+'\n');
  assert.deepEqual(contacts.items[0].emails,["first@example.invalid","second@example.invalid"]);
  assert.deepEqual(contacts.items[0].phones,["111","222"]);
  assert.equal(parseVaultCsv('name,url,username,password,websites\nSample,https://first.invalid,user,synthetic,broken\n').skipped,1);
});
