import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildOnce, entryChunk, isModule } from "./support.mts";
import { fileURLToPath } from "node:url";

const chatPath = fileURLToPath(new URL("../src/components/Chat.tsx", import.meta.url));
const composerPath = fileURLToPath(new URL("../src/components/ComposerActions.tsx", import.meta.url));
const behaviorPath = fileURLToPath(new URL("../src/lib/chatBehavior.ts", import.meta.url));
const storePath = fileURLToPath(new URL("../src/store.ts", import.meta.url));
const workspacePath = fileURLToPath(new URL("../src/components/WorkspaceResource.tsx", import.meta.url));
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "mobile-chat-test",
    resolveId: (id) => id.endsWith("virtual:mobile-chat-test") ? "\0mobile-chat-test" : undefined,
    load: (id) => id === "\0mobile-chat-test" ? `
      export { Composer, BotBubble, AttachmentList } from ${JSON.stringify(chatPath)};
      export { ComposerActions } from ${JSON.stringify(composerPath)};
      export * from ${JSON.stringify(behaviorPath)};
      export { useApp } from ${JSON.stringify(storePath)};
      export { WorkspaceFileContext } from ${JSON.stringify(workspacePath)};
      export { createElement } from "react";
      export { renderToStaticMarkup, renderToReadableStream } from "react-dom/server";
    ` : undefined,
    // Exercise the real components without making their implementation public app APIs.
    transform: (code, id) => isModule(id, chatPath)
      ? { code: code + "\nexport { Composer, AttachmentList };", map: null }
      : undefined,
  }],
  ssr: { noExternal: true },
  build: { rollupOptions: { output: { inlineDynamicImports: true } }, ssr: "virtual:mobile-chat-test", write: false },
});
const entry = entryChunk(bundle);
assert.ok(entry);
const drafts = new Map();
// Server-render stand-ins: the Composer reads only these members of the browser globals.
type BrowserWindow = typeof globalThis.window;
globalThis.localStorage = { getItem: (key) => drafts.get(key) ?? null } as Partial<Storage> as Storage;
globalThis.window = {} as BrowserWindow;
// React's Node server renderer uses createRequire(import.meta.url), which needs a file URL.
const temporary = await mkdtemp(join(tmpdir(), "bot-mobile-chat-test-"));
let loaded;
try {
  const output = join(temporary, "chat.mjs");
  await writeFile(output, entry.code);
  loaded = await import(pathToFileURL(output).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const {
  composerFocusBehavior, MOBILE_CHAT_QUERY, splitBubbles, takeAttachmentFiles,
  Composer, ComposerActions, BotBubble, AttachmentList, useApp, WorkspaceFileContext,
  createElement: h, renderToStaticMarkup: render, renderToReadableStream,
} = loaded;

function textarea(readOnly) {
  return {
    readOnly, focusCalls: 0, blurCalls: 0,
    focus() { this.focusCalls++; },
    blur() { this.blurCalls++; },
  };
}

test("mobile entry, chat switches and remounts never focus the composer", () => {
  const target = textarea(true);
  for (let chat = 0; chat < 3; chat++) {
    const behavior = composerFocusBehavior(true);
    behavior.onEntry(target);
    assert.equal(target.focusCalls, 0);
    assert.equal(target.readOnly, true);
  }
});

test("mobile tapping enables editing, then overlay restoration is rejected", () => {
  const target = textarea(true);
  const behavior = composerFocusBehavior(true);
  behavior.onPointerDown(target);
  assert.equal(target.readOnly, false, "the tap enables editing before native focus");
  behavior.onFocus(target);
  assert.equal(target.blurCalls, 0);
  assert.equal(target.readOnly, false);
  behavior.onBlur(target);
  assert.equal(target.readOnly, true, "closing the keyboard rearms tap-only editing");
  behavior.onFocus(target); // Modal/BotExchange restoring previousFocus.focus().
  assert.equal(target.readOnly, true);
  assert.equal(target.blurCalls, 1);
  behavior.onPointerDown(target);
  behavior.onFocus(target);
  assert.equal(target.readOnly, false, "another explicit tap still works");
  assert.equal(target.blurCalls, 1);
});

test("a cancelled touch cannot authorize a later programmatic focus", () => {
  const target = textarea(true);
  const behavior = composerFocusBehavior(true);
  behavior.onPointerDown(target);
  behavior.onPointerCancel(target);
  assert.equal(target.readOnly, true);
  behavior.onFocus(target);
  assert.equal(target.blurCalls, 1);
});

test("scrolling inside an already active composer keeps editing enabled", () => {
  const target = textarea(true);
  const behavior = composerFocusBehavior(true);
  behavior.onPointerDown(target);
  behavior.onFocus(target);
  behavior.onPointerDown(target);
  behavior.onPointerCancel(target);
  assert.equal(target.readOnly, false);
  assert.equal(target.blurCalls, 0);
});

test("desktop entry and focus restoration stay editable", () => {
  const target = textarea(false);
  const behavior = composerFocusBehavior(false);
  behavior.onEntry(target);
  behavior.onPointerDown(target);
  behavior.onFocus(target);
  behavior.onBlur(target);
  behavior.onFocus(target);
  assert.equal(target.focusCalls, 1);
  assert.equal(target.blurCalls, 0);
  assert.equal(target.readOnly, false);
});

const bot = { slug: "example", name: "Example", mainThreadId: "main", color: "teal", shape: "blob" };
test("the real composer renders mobile tap protection while retaining each thread's draft", () => {
  drafts.set("bot.draft.example", "A saved main draft");
  drafts.set("bot.draft.child", "A saved child draft");
  const queries = [];
  globalThis.window = { matchMedia: (query) => { queries.push(query); return { matches: true } as MediaQueryList; } } as Partial<BrowserWindow> as BrowserWindow;
  const main = render(h(Composer, { bot, threadId: "main", working: false }));
  const child = render(h(Composer, { bot, threadId: "child", working: true }));
  assert.match(main, /<textarea[^>]*readOnly=""[^>]*>A saved main draft<\/textarea>/);
  assert.match(child, /<textarea[^>]*readOnly=""[^>]*>A saved child draft<\/textarea>/);
  assert.match(main, /enterkeyhint="enter"/i);
  assert.ok(queries.every((query) => query === MOBILE_CHAT_QUERY));
  assert.match(MOBILE_CHAT_QUERY, /max-width: 760px/);
  assert.match(MOBILE_CHAT_QUERY, /pointer: coarse/);
  globalThis.window = { matchMedia: () => ({ matches: false }) as MediaQueryList } as Partial<BrowserWindow> as BrowserWindow;
  const desktop = render(h(Composer, { bot, threadId: "main", working: false }));
  assert.doesNotMatch(desktop, /<textarea[^>]*readOnly/);
  assert.doesNotMatch(desktop, /enterkeyhint/i);
  assert.match(desktop, />A saved main draft<\/textarea>/);
});

function picker(mobile) {
  return render(h(ComposerActions, { mobile, onFiles() {} }));
}
function input(markup, label) {
  return markup.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

test("mobile attachment actions render distinct native library, camera and file semantics", () => {
  // The menu itself is opened by a tap in mobile-composer.test; the inputs are always mounted so a
  // picker's result still arrives after the menu closes.
  const markup = picker(true);
  const library = input(markup, "Photo library");
  assert.match(library, /type="file"/);
  assert.match(library, /accept="image\/\*,video\/\*"/);
  assert.match(library, /multiple=""/);
  assert.doesNotMatch(library, /capture=/);
  const camera = input(markup, "Take photo");
  assert.match(camera, /accept="image\/\*"/);
  assert.match(camera, /capture="environment"/);
  assert.doesNotMatch(camera, /multiple=/);
  const files = input(markup, "Files");
  assert.match(files, /multiple=""/);
  assert.doesNotMatch(files, /accept=|capture=/);
});

test("closing the attachment menu leaves all native inputs mounted for picker results", () => {
  const markup = picker(true);
  assert.doesNotMatch(markup, /role="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  for (const label of ["Photo library", "Take photo", "Files"]) {
    assert.match(input(markup, label), /hidden=""/);
  }
});

test("desktop keeps one unrestricted multiple-file picker", () => {
  const markup = picker(false);
  assert.equal((markup.match(/<input/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /capture=|accept=|Photo library|Take photo/);
  assert.match(input(markup, "Files"), /multiple=""/);
});

test("picker results snapshot files before reset and allow reselecting the same file", () => {
  const first = new File(["example"], "example.txt", { type: "text/plain" });
  const photo = new File(["photo"], "example.jpg", { type: "image/jpeg" });
  let nativeFiles = [first, photo];
  let nativeValue = "C:\\fakepath\\example.txt";
  const pickerInput = {
    get files() { return nativeFiles; },
    get value() { return nativeValue; },
    set value(value) { nativeValue = value; nativeFiles = []; },
  };
  const selected = takeAttachmentFiles(pickerInput);
  assert.deepEqual(selected, [first, photo]);
  assert.equal(selected[0], first);
  assert.equal(nativeValue, "");
  nativeFiles = [first];
  assert.deepEqual(takeAttachmentFiles(pickerInput), [first]);
  assert.deepEqual(takeAttachmentFiles({ files: null, value: "" }), [], "cancelling adds no files");
});

test("rich message markup preserves full URLs, code, tables, images and attachment names", () => {
  useApp.setState({ bots: {} });
  const longUrl = "https://example.test/" + "segment".repeat(100);
  const code = "wide ".repeat(150);
  const markup = render(h(BotBubble, { text: `${longUrl}\n\n\`\`\`text\n${code}\n\`\`\`\n\n| Name | Value |\n| --- | --- |\n| Wide | ${"cell".repeat(100)} |\n\n![Example](https://example.test/image.png)` }));
  assert.ok(markup.includes(`href="${longUrl}"`), "long links are preserved");
  assert.ok(markup.includes(code), "wide code stays intact inside pre/code");
  assert.match(markup, /<pre><code/);
  assert.match(markup, /<table>/);
  assert.match(markup, /<img[^>]*src="https:\/\/example.test\/image.png"/);
  const attachments = render(h(AttachmentList, { attachments: [
    { id: "image", type: "image", name: "photo.jpg", previewUrl: "https://example.test/photo.jpg" },
    { id: "file", type: "file", name: "long-file-name".repeat(100) + ".pdf" },
  ] }));
  assert.match(attachments, /chat-attachments/);
  assert.match(attachments, /chat-attachment-image/);
  assert.ok(attachments.includes("long-file-name".repeat(100) + ".pdf"));
});


test("short prose still groups into bubbles, keeping introductions and lists together", () => {
  assert.deepEqual(splitBubbles("First paragraph.\n\nSecond paragraph."), ["First paragraph.", "Second paragraph."]);
  assert.deepEqual(splitBubbles("Choose one:\n\n- One\n- Two\n\nAnother thought."), ["Choose one:\n\n- One\n- Two", "Another thought."]);
  assert.deepEqual(splitBubbles("Steps\n\n1. First\n2. Second\n\nFinished."), ["Steps\n\n1. First\n2. Second", "Finished."]);
  assert.deepEqual(splitBubbles("Budget $5.\n\nRemaining $10."), ["Budget $5.", "Remaining $10."]);
  const many = "One.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.";
  assert.deepEqual(splitBubbles(many), [many], "long stacks keep the existing single-bubble limit");
});

test("display math and both code fence styles survive bubble grouping verbatim", async () => {
  useApp.setState({ bots: {} });
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"]]) {
    const text = `Before.\n\n${open}\nx^2 +\n\ny^2\n${close}\n\nAfter.`;
    assert.deepEqual(splitBubbles(text), [text], `${open} math keeps its internal blank lines`);
    const stream = await renderToReadableStream(h(BotBubble, { text }));
    await stream.allReady;
    const markup = await new Response(stream).text();
    assert.equal((markup.match(/rich-math-display/g) ?? []).length, 1, `${open} reaches the real math parser intact`);
    assert.match(markup, /<math/);
    assert.ok(markup.includes("Before.") && markup.includes("After."));
    assert.deepEqual(splitBubbles(`Before.\n\n${open}\nx^2\n\ny^2`), [`Before.\n\n${open}\nx^2\n\ny^2`], "streaming math stays together before its closing delimiter arrives");
  }
  for (const fence of ["```", "~~~", "~~~~"]) {
    const code = "first line\n\nsecond line";
    const text = `Before.\n\n${fence}text\n${code}\n${fence}\n\nAfter.`;
    assert.deepEqual(splitBubbles(text), [text], `${fence} code keeps its internal blank lines`);
    const markup = render(h(BotBubble, { text }));
    assert.match(markup, /<pre><code[^>]*>first line\n\nsecond line\n<\/code><\/pre>/);
    assert.deepEqual(splitBubbles(`Before.\n\n${fence}mermaid\ngraph TD\n\nA --> B`), [`Before.\n\n${fence}mermaid\ngraph TD\n\nA --> B`], "streaming fences stay together before their closing fence arrives");
  }
});

test("a Bot message's file stack draws each linked file once and leaves no linked file unreachable", () => {
  useApp.setState({ bots: {} });
  const workspace = { workspaceRoot: "/home/user/bot", threadId: "thread-1", openFile() {} };
  const bubble = (text: string) => render(h(WorkspaceFileContext, { value: workspace }, h(BotBubble, { text })));
  // A reference-style link is not one the stack collects, so its own paragraph keeps the card (five paragraphs stay one bubble).
  const reference = bubble("One.\n\nTwo.\n\nThree.\n\n[Budget][budget]\n\n[budget]: library/budget.xlsx");
  assert.equal((reference.match(/aria-label="Open Budget"/g) ?? []).length, 1);
  // An inline image already shows in the bubble; the stack does not add a second tile for it.
  const inline = bubble("The chart:\n\n![Bars](library/bars.svg)\n\n[report.pdf](library/report.pdf)");
  assert.doesNotMatch(inline, /aria-label="Open Bars"/);
  assert.equal((inline.match(/aria-label="Open report\.pdf"/g) ?? []).length, 1);
  // Five images on their own lines: three tiles, the last of which opens the rest of the row.
  const media = bubble(Array.from({ length: 5 }, (_, i) => `[shot-${i}.png](library/shot-${i}.png)`).join("\n\n"));
  assert.equal((media.match(/aria-label="Open shot-\d\.png"/g) ?? []).length, 2);
  assert.match(media, /aria-label="Show 3 more files"/);
});
