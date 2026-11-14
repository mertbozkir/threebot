import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { buildOnce, entryChunk } from "./support.mts";
import { MAX_CHANGES, MAX_HIGHLIGHTS, avatarUrl, parseReleaseNotes, profileUrl } from "../src/lib/releaseNotes.ts";

const src = new URL("../src/", import.meta.url).pathname;
const bundle = await buildOnce({
  configFile: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "release-notes-test-entry",
    resolveId: (id) => id.endsWith("virtual:release-notes-test") ? "\0release-notes-test" : undefined,
    load: (id) => id === "\0release-notes-test" ? `
      export { createElement as h } from "react";
      export { renderToStaticMarkup } from "react-dom/server";
      export { ReleaseNotesView } from ${JSON.stringify(`${src}components/ReleaseNotes.tsx`)};` : undefined,
  }],
  ssr: { noExternal: true },
  build: { ssr: "virtual:release-notes-test", write: false },
});
const dir = await mkdtemp(join(tmpdir(), "bot-release-notes-"));
const file = join(dir, "entry.mjs");
await writeFile(file, entryChunk(bundle).code);
const { h, renderToStaticMarkup, ReleaseNotesView } = await import(pathToFileURL(file).href);
after(async () => { await rm(dir, { recursive: true, force: true }); });

const pr = (n: number) => `https://github.com/RokaSwK/threebot/pull/${n}`;

// What scripts/release-notes.mts writes, which is T3 Code's format.
const T3_FORMAT = `**v0.1.7** · 5 changes from 3 contributors

- **Web Push.** Get a notification on your phone when a Bot needs you.
- **Mac app.** Run Threebot in its own window (beta).

### Plus 3 more changes.

<details>
<summary>Full changelog</summary>

## What's Changed
* Web Push notifications by @cristianbdev in ${pr(41)}
* Mac app: Threebot in a native window by @mertbozkir in ${pr(43)}
* Bump vite by @dependabot in ${pr(44)}
* Show every Library filter by @RokaSwK in ${pr(45)}
* Threebot 0.1.7 by @RokaSwK in ${pr(48)}

## New Contributors
* @mertbozkir made their first contribution in ${pr(43)}

**Full Changelog**: https://github.com/RokaSwK/threebot/compare/v0.1.6...v0.1.7

</details>
`;

// Threebot's v0.1.6 body as GitHub generated it, before this format.
const GITHUB_GENERATED = `## What's Changed
* Landing: show the GitHub star count by @RokaSwK in ${pr(35)}
* feat: add Web Push notifications by @cristianbdev in ${pr(41)}
* Mac app: Threebot in a native window by @mertbozkir in ${pr(43)}
* Threebot 0.1.6 by @RokaSwK in ${pr(48)}

## New Contributors
* @mertbozkir made their first contribution in ${pr(43)}

**Full Changelog**: https://github.com/RokaSwK/threebot/compare/v0.1.5...v0.1.6`;

test("reads T3 Code's format: header, highlights, Plus N more, changelog with authors, people without bots", () => {
  const notes = parseReleaseNotes(T3_FORMAT);
  assert.equal(notes.stats, "5 changes from 3 contributors");
  assert.deepEqual(notes.highlights, [
    { label: "Web Push", text: "Get a notification on your phone when a Bot needs you." },
    { label: "Mac app", text: "Run Threebot in its own window (beta)." },
  ]);
  assert.equal(notes.footer, "Plus 3 more changes.");
  assert.equal(notes.totalChanges, 5);
  assert.deepEqual(notes.changes[0], { title: "Web Push notifications", author: "cristianbdev", url: pr(41) });
  assert.equal(notes.changes[2].author, "dependabot", "a bot's change is listed with its author");
  assert.deepEqual(notes.contributors, ["cristianbdev", "mertbozkir", "RokaSwK"], "bots aren't contributors");
  assert.deepEqual(notes.newContributors, ["mertbozkir"]);
});

test("reads GitHub's own notes, with no highlights, and counts the header from the list", () => {
  const notes = parseReleaseNotes(GITHUB_GENERATED);
  assert.equal(notes.stats, "4 changes from 3 contributors");
  assert.deepEqual(notes.highlights, []);
  assert.equal(notes.footer, null);
  assert.deepEqual(notes.changes.map((c) => [c.title, c.author]), [
    ["Landing: show the GitHub star count", "RokaSwK"], ["feat: add Web Push notifications", "cristianbdev"],
    ["Mac app: Threebot in a native window", "mertbozkir"], ["Threebot 0.1.6", "RokaSwK"],
  ]);
  assert.deepEqual(parseReleaseNotes(GITHUB_GENERATED.replace(/\n/g, "\r\n")).changes.length, 4, "Windows line ends");
});

test("empty and odd bodies give nothing to show instead of throwing", () => {
  for (const body of [null, undefined, "", "   ", 42, { body: "x" }]) assert.deepEqual(parseReleaseNotes(body).changes, []);
  assert.equal(parseReleaseNotes("Just a paragraph.").stats, null);
});

test("limits: seven highlights, a hundred changes, long titles cut", () => {
  const many = Array.from({ length: 10 }, (_, i) => `- **H${i}.** Sentence ${i}.`).join("\n");
  const list = Array.from({ length: 150 }, (_, i) => `* Change ${i} ${"word ".repeat(i === 0 ? 80 : 1)}by @person${i % 5} in ${pr(i + 1)}`).join("\n");
  const notes = parseReleaseNotes(`**v1.0.0** · 150 changes from 5 contributors\n\n${many}\n\n<details><summary>Full changelog</summary>\n\n## What's Changed\n${list}\n</details>`);
  assert.equal(notes.highlights.length, MAX_HIGHLIGHTS);
  assert.equal(notes.changes.length, MAX_CHANGES);
  assert.equal(notes.totalChanges, 150);
  assert.ok(notes.changes[0].title.length <= 220 && notes.changes[0].title.endsWith("…"));
  assert.equal(notes.totalContributors, 5);
});

const MALICIOUS = `**v6.6.6** · <img src=x onerror=alert(1)>2 changes from 1 contributor

- **<script>alert("label")</script>Pwned.** Click <a href="javascript:alert(1)">here</a> &lt;script&gt;alert(2)&lt;/script&gt; [link](javascript:alert(3)) ![x](https://evil.test/pixel.png)
- **Hidden.** <style>body{display:none}</style>Text<iframe src="https://evil.test"></iframe> ‮esrever

### Plus 1 more <b onclick="x()">change</b>.

<details><summary>Full changelog</summary>

## What's Changed
* <svg onload=alert(4)></svg>Sneaky title by @evil"onmouseover=alert(5) in javascript:alert(6)
* Spoofed link by @real-user in https://github.com.evil.test/pull/1
* Login with a path by @../../settings in ${pr(2)}
* Good one by @good-user in ${pr(3)}
</details>`;

test("untrusted bodies: markup stripped, only github.com links, only valid logins", () => {
  const notes = parseReleaseNotes(MALICIOUS);
  const all = JSON.stringify(notes);
  for (const bad of ["<script", "onerror", "<img", "<iframe", "<svg", "javascript:", "evil.test", "display:none", "‮", "onclick"]) assert.ok(!all.includes(bad), `no ${bad} in ${all}`);
  assert.equal(notes.stats, "2 changes from 1 contributor");
  assert.equal(notes.highlights[0].label, "Pwned");
  // An escaped tag is text, and stays text: it's decoded once and rendered as text, never as HTML.
  assert.match(notes.highlights[0].text, /^Click here scriptalert\(2\)\/script link$/);
  assert.equal(notes.footer, "Plus 1 more change.");
  assert.deepEqual(notes.changes.map((c) => [c.author, c.url]), [[null, null], ["real-user", null], [null, pr(2)], ["good-user", pr(3)]]);
  assert.deepEqual(notes.contributors, ["real-user", "good-user"]);
});

test("avatars and profiles are GitHub URLs built from a checked login", () => {
  assert.equal(avatarUrl("RokaSwK"), "https://github.com/RokaSwK.png?size=40");
  assert.equal(profileUrl("RokaSwK"), "https://github.com/RokaSwK");
  assert.equal(profileUrl("renovate[bot]"), "https://github.com/apps/renovate");
});

test("the view shows the header, highlights, Plus N more, contributors, the changelog with authors and View on GitHub", () => {
  const html = renderToStaticMarkup(h(ReleaseNotesView, { release: { version: "0.1.7", url: "https://github.com/RokaSwK/threebot/releases/tag/v0.1.7", notes: T3_FORMAT, publishedAt: null } }));
  assert.match(html, /v0\.1\.7<\/span><span[^>]*>· 5 changes from 3 contributors/);
  assert.match(html, /Web Push\. <\/span><span[^>]*>Get a notification/);
  assert.match(html, /Plus 3 more changes\./);
  assert.match(html, /href="https:\/\/github\.com\/mertbozkir"[^>]*aria-label="@mertbozkir on GitHub"/);
  assert.match(html, /<img src="https:\/\/github\.com\/RokaSwK\.png\?size=40"[^>]*loading="lazy"/);
  assert.match(html, /<details[^>]*>.*Full changelog.*Bump vite<\/a> <a href="https:\/\/github\.com\/dependabot"[^>]*>@dependabot<\/a>/s);
  assert.match(html, />View on GitHub</);
  assert.ok(!/aria-label="@dependabot on GitHub"/.test(html), "no bot in the contributor row");
});

test("the view renders a malicious body as text", () => {
  const html = renderToStaticMarkup(h(ReleaseNotesView, { release: { version: "6.6.6", url: "https://github.com/RokaSwK/threebot/releases/tag/v6.6.6", notes: MALICIOUS, publishedAt: null } }));
  // (The view's own icons are SVG, so look for the body's onload instead of <svg.)
  for (const bad of ["<script", "onerror", "onload", "<iframe", "javascript:", "evil.test", "onclick", "onmouseover"]) assert.ok(!html.includes(bad), `no ${bad}`);
  // The decoded `<script>` from `&lt;script&gt;` would come out escaped, but the parser drops brackets anyway.
  assert.ok(!html.includes("&lt;script"));
});
