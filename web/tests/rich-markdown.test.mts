import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { buildOnce, entryChunk } from "./support.mts";
import { fileURLToPath } from "node:url";

// Actual Markdown parser, KaTeX, Mermaid renderer and DOMPurify. jsdom has no
// layout engine: only SVG text/bounds metrics are approximated. These assertions
// verify content, security and interactions, never diagram geometry or parity.
const window = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://rich-markdown.test", pretendToBeVisual: true }).window;
for (const key of ["window", "document", "navigator", "Element", "HTMLElement", "SVGElement", "DOMParser", "MutationObserver", "CSSStyleSheet", "getComputedStyle", "Node", "Event", "MouseEvent", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
Object.defineProperty(window.SVGElement.prototype, "getComputedTextLength", { configurable: true, value() { return (this.textContent ?? "").length * 8; } });
Object.defineProperty(window.SVGElement.prototype, "getBBox", { configurable: true, value() { return { x: 0, y: 0, width: Math.max(16, (this.textContent ?? "").length * 8), height: 20 }; } });
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const src = fileURLToPath(new URL("../src/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "bot-rich-markdown-"));
await symlink(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(directory, "node_modules"), "dir");
const bundle = await buildOnce({
  configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "rich-markdown-test-entry", resolveId: (id) => id.endsWith("virtual:rich-markdown-tests") ? "\0rich-markdown-tests" : undefined,
    load: (id) => id === "\0rich-markdown-tests" ? `
      export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { RichMarkdown } from ${JSON.stringify(src + "components/RichMarkdown.tsx")};
      export { renderMermaid } from ${JSON.stringify(src + "components/MermaidDiagram.tsx")};` : undefined }],
  ssr: { noExternal: true, external: ["mermaid", "dompurify"] },
  build: { ssr: "virtual:rich-markdown-tests", write: false },
});
for (const output of bundle.output) if (output.type === "chunk") { const file = join(directory, output.fileName); await mkdir(dirname(file), { recursive: true }); await writeFile(file, output.code); }
const entry = entryChunk(bundle);
assert.ok(entry);
const { createElement: h, act, createRoot, RichMarkdown, renderMermaid } = await import(pathToFileURL(join(directory, entry.fileName)).href);
let root, host, copied;
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => copied.push(text) } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); document.documentElement.classList.remove("dark"); });
after(async () => { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } window.close(); await rm(directory, { recursive: true, force: true }); });
const render = async (text, props = {}) => act(async () => root.render(h(RichMarkdown, props, text)));
const click = async (button) => { assert.ok(button); await act(async () => button.click()); };
const waitFor = async (predicate) => {
  const deadline = Date.now() + 7000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("Expected renderer state did not appear.");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
};

test("actual parser renders dollar and backslash inline/display math with accessible MathML", async () => {
  await render("Inline $x^2+1$ and \\(\\frac{1}{2}\\).\n\n$$\na^2+b^2=c^2\n$$\n\n\\[E=mc^2\\]");
  await waitFor(() => document.querySelectorAll(".rich-math").length === 4);
  assert.equal(document.querySelectorAll(".rich-math").length, 4);
  assert.equal(document.querySelectorAll(".rich-math-display").length, 2);
  assert.equal(document.querySelectorAll("math").length, 4);
  assert.equal(document.querySelectorAll("annotation[encoding='application/x-tex']").length, 4);
  assert.equal(document.querySelector("annotation").textContent, "x^2+1");
  assert.equal(document.querySelector(".md-code-block"), null);
});

test("two prices on one line stay text while inline math still renders", async () => {
  await render("Groq costs about $36 for all 888 hours at $0.04/hour, or about $99 with large-v3. Area is $x^2$.");
  const paragraph = document.querySelector("p");
  assert.match(paragraph.textContent, /about \$36 for all 888 hours at \$0\.04\/hour, or about \$99 with large-v3/);
  assert.equal(document.querySelectorAll(".katex").length, 1, "only the formula is math");
  assert.match(document.querySelector(".katex annotation").textContent, /x\^2/);
});

test("code, GFM, Bot references and caller navigation survive the math extension", async () => {
  let clicked;
  await render("Ask @Beta. Keep `\\(x\\)` and `$cash$` literal. Price: $25.\n\n| Name | Value |\n| --- | --- |\n| sample | yes |\n\n```js\nconst value = '$x$ \\(x\\)';\n```\n\n```math\nx^2\n```", {
    bots: [{ slug: "beta", name: "Beta" }],
    components: { a: ({ href, children }) => h("button", { onClick: () => { clicked = href; }, "data-link": href }, children) },
  });
  assert.equal(document.querySelector("table tbody td").textContent, "sample");
  assert.deepEqual([...document.querySelectorAll("p > code")].map((code) => code.textContent), ["\\(x\\)", "$cash$"]);
  assert.equal(document.querySelectorAll(".rich-math").length, 0);
  assert.deepEqual([...document.querySelectorAll(".md-code-block pre")].map((pre) => pre.textContent), ["const value = '$x$ \\(x\\)';\n", "x^2\n"]);
  await click(document.querySelector('[data-link="bot:beta"]'));
  assert.equal(clicked, "bot:beta");
});

test("untrusted math cannot create links, remote images or HTML and malformed math remains readable", async () => {
  await render("$\\href{javascript:alert(1)}{click}$\n\n$\\includegraphics{https://example.invalid/private}$\n\n$\\htmlClass{injected}{x}$\n\n$\\frac{$");
  await waitFor(() => document.querySelectorAll(".rich-math").length === 4);
  assert.equal(document.querySelector("a,img,.injected,script"), null);
  assert.ok(document.querySelector(".katex-error"));
  assert.match(document.body.textContent, /\\frac\{/);
});

test("real Mermaid parser and engine produce nodes/edges and enforce the SVG boundary", async () => {
  const source = '%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"@import url(https://example.invalid/style);"}}%%\nflowchart LR\nA["Input <img src=x onerror=alert(1)>"] --> B[Result]\nclick A href "javascript:alert(1)"';
  const svg = await renderMermaid(source, "light", "rich-mermaid-security");
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  assert.equal(parsed.documentElement.localName, "svg");
  assert.match(parsed.documentElement.textContent, /Input/);
  assert.match(parsed.documentElement.textContent, /Result/);
  assert.ok(parsed.querySelector("path"), "engine generated an actual edge");
  assert.equal(parsed.querySelector("a,script,foreignObject,image,use,animate,set"), null);
  assert.equal(parsed.querySelector('[href],[onclick],[onerror]'), null);
  assert.doesNotMatch(svg, /@import|https:\/\/example\.invalid\/style/);
  await assert.rejects(renderMermaid("not a valid diagram", "light", "rich-mermaid-invalid"));
});

test("diagram source/copy, retry and source replacement use actual render outcomes", { timeout: 15000 }, async () => {
  const invalid = "not a valid diagram <literal>";
  await render("```mermaid\n" + invalid + "\n```");
  await waitFor(() => document.querySelector('[data-diagram-state="error"]'));
  assert.equal(document.querySelector(".mermaid-source").textContent, invalid);
  await click(document.querySelector('[aria-label="Copy diagram source"]'));
  assert.deepEqual(copied, [invalid]);
  assert.ok(document.querySelector('[aria-label="Copied"]'));
  await click([...document.querySelectorAll("button")].find((button) => button.textContent.includes("Try again")));
  await waitFor(() => document.querySelector('[data-diagram-state="error"]'));
  await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Source"));
  const valid = "flowchart LR\nA[Start] --> B[Finish]";
  await render("```mermaid\n" + valid + "\n```");
  assert.equal(document.querySelector<HTMLElement>(".mermaid-card").dataset.diagramState, "loading");
  assert.equal(document.querySelector(".mermaid-toolbar button").getAttribute("aria-pressed"), "true");
  assert.equal(document.querySelector(".mermaid-source").textContent, valid);
  await waitFor(() => document.querySelector('[data-diagram-state="ready"]'));
  await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Source"));
  assert.match(document.querySelector(".mermaid-canvas svg").textContent, /Finish/);
  assert.equal(document.querySelector(".mermaid-source"), null);
  await click(document.querySelector('[aria-label="Copy diagram source"]'));
  assert.deepEqual(copied, [invalid, valid]);
});

test("concurrent diagrams keep their own theme and renderer errors do not poison the queue", async () => {
  const source = "flowchart LR\nA[One] --> B[Two]";
  const [light, dark] = await Promise.all([renderMermaid(source, "light", "rich-theme-light"), renderMermaid(source, "dark", "rich-theme-dark")]);
  assert.match(light, /One/); assert.match(dark, /Two/);
  const lightStyle = new DOMParser().parseFromString(light, "image/svg+xml").querySelector("style").textContent;
  const darkStyle = new DOMParser().parseFromString(dark, "image/svg+xml").querySelector("style").textContent;
  assert.match(lightStyle, /#eee/);
  assert.match(darkStyle, /#1f2020/);
  await assert.rejects(renderMermaid("bad diagram", "light", "rich-queue-error"));
  assert.match(await renderMermaid(source, "light", "rich-queue-recovered"), /Two/);
});


test("diagram preview opens the rendered drawing, zooms and returns without changing source", async () => {
  const source = "flowchart LR\nA[Preview] --> B[Return]";
  await render("```mermaid\n" + source + "\n```");
  await waitFor(() => document.querySelector('[data-diagram-state="ready"]'));
  await click(document.querySelector('[aria-label="Open diagram preview"]'));
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Preview/);
  assert.equal(dialog.querySelectorAll("svg").length > 0, true);
  await click(dialog.querySelector('[aria-label="Zoom in"]'));
  assert.equal(dialog.querySelector('[aria-label="Zoom level"]').textContent, "125%");
  await click(dialog.querySelector('[aria-label="Reset zoom"]'));
  assert.equal(dialog.querySelector('[aria-label="Zoom level"]').textContent, "100%");
  await click(dialog.querySelector('[aria-label="Close"]'));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelector<HTMLElement>('.mermaid-card').dataset.diagramState, "ready");
  await click(document.querySelector('[aria-label="Copy diagram source"]'));
  assert.deepEqual(copied, [source]);
});
