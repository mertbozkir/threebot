import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildReleaseNotes, countContributors, formatFooter, formatHeader, main, readChanges, readHighlights } from "./release-notes.mts";

const pr = (n: number) => `https://github.com/RokaSwK/threebot/pull/${n}`;
const GENERATED = `## What's Changed
* Show the GitHub star count by @alice in ${pr(1)}
* fix: keep the release pill current by @alice in ${pr(2)}
* Bump vite from 7.0.0 to 7.1.0 by @dependabot in ${pr(3)}
* Web Push notifications by @bob in ${pr(4)}
* Update lockfile by @renovate[bot] in ${pr(5)}
* Mac app in a native window by @carol in ${pr(6)}

## New Contributors
* @carol made their first contribution in ${pr(6)}

**Full Changelog**: https://github.com/RokaSwK/threebot/compare/v0.1.6...v0.1.7`;

test("reads GitHub's What's Changed list and leaves New Contributors out", () => {
  const changes = readChanges(GENERATED);
  assert.equal(changes.length, 6);
  assert.deepEqual(changes[0], { title: "Show the GitHub star count", login: "alice", number: 1, url: pr(1) });
  assert.deepEqual(changes.map((c) => c.number), [1, 2, 3, 4, 5, 6]);
});

test("counts each person once and skips bots, by GitHub's answer or by name", () => {
  const changes = readChanges(GENERATED);
  assert.equal(countContributors(changes), 3, "dependabot and renovate[bot] are known bots");
  // GitHub says PR 4's author is an app, though its name looks like a person's.
  const authors = new Map([[4, { login: "bob", bot: true }], [1, { login: "Alice", bot: false }]]);
  assert.equal(countContributors(changes, authors), 2);
  assert.equal(countContributors([]), 0);
});

test("formats the header like T3 Code's, singular and plural", () => {
  assert.equal(formatHeader("v0.1.7", 23, 4), "**v0.1.7** · 23 changes from 4 contributors");
  assert.equal(formatHeader("0.1.7", 1, 1), "**v0.1.7** · 1 change from 1 contributor");
});

test("reads highlights, drops PR references and refuses more than seven or a missing label", () => {
  const highlights = readHighlights("# Highlights for 0.1.7\n\n- **Web Push.** Get a notification when a Bot needs you. (#4)\n- **Mac app** Run Threebot in its own window (beta). (#6, #1)\nnot a bullet\n");
  assert.deepEqual(highlights, [
    { label: "Web Push", detail: "Get a notification when a Bot needs you.", prs: [4] },
    { label: "Mac app", detail: "Run Threebot in its own window (beta).", prs: [6, 1] },
  ]);
  assert.throws(() => readHighlights(Array.from({ length: 8 }, (_, i) => `- **H${i}.** Sentence.`).join("\n")), /Up to 7/);
  assert.throws(() => readHighlights("- Just a sentence."), /bold label/);
});

test("Plus N more counts what the highlights don't cover", () => {
  const changes = readChanges(GENERATED);
  assert.equal(formatFooter(changes, readHighlights("- **Push.** A sentence. (#4)\n- **Mac.** A sentence. (#6, #1)")), "### Plus 3 more changes.");
  // Without PR references each highlight covers one change.
  assert.equal(formatFooter(changes, readHighlights("- **Push.** A sentence.")), "### Plus 5 more changes.");
  assert.equal(formatFooter(changes, []), "**6 changes.**");
  const fixes = readChanges(`* fix: one by @a in ${pr(1)}\n* fix(web): two by @a in ${pr(2)}\n* perf: three by @a in ${pr(3)}\n* Big feature by @a in ${pr(4)}`);
  assert.equal(formatFooter(fixes, readHighlights("- **Big.** Feature. (#4)")), "### Plus 3 more bug fixes and performance improvements.");
  assert.equal(formatFooter(fixes.slice(0, 2), readHighlights("- **Big.** Feature. (#4)")), "### Plus 2 more bug fixes.");
  assert.equal(formatFooter(fixes.slice(2), readHighlights("- **Big.** Feature. (#4)")), "### Plus 1 more performance improvement.");
  assert.equal(formatFooter(fixes.slice(3), readHighlights("- **Big.** Feature. (#4)")), null);
});

test("builds the whole body: header, highlights, Plus N more, GitHub's list folded", () => {
  const body = buildReleaseNotes({ version: "v0.1.7", generated: GENERATED + "\n", highlights: readHighlights("- **Web Push.** Get a notification when a Bot needs you. (#4)") });
  assert.equal(body, `**v0.1.7** · 6 changes from 3 contributors

- **Web Push.** Get a notification when a Bot needs you.

### Plus 5 more changes.

<details>
<summary>Full changelog</summary>

${GENERATED}

</details>
`);
  assert.match(buildReleaseNotes({ version: "0.1.7", generated: GENERATED }), /^\*\*v0\.1\.7\*\* · 6 changes from 3 contributors\n\n\*\*6 changes\.\*\*\n\n<details>/);
});

test("the command asks gh for the notes and the authors, then writes the body", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "release-notes-"));
  try {
    await writeFile(path.join(dir, "highlights.md"), "- **Web Push.** Get a notification when a Bot needs you. (#4)\n");
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[1] === "graphql") return JSON.stringify({ data: { repository: { pr1: { author: { __typename: "User", login: "alice" } }, pr4: { author: { __typename: "Bot", login: "bob" } } } } });
      return GENERATED + "\n";
    };
    const out = path.join(dir, "notes.md");
    main(["v0.1.6", "v0.1.7", "--highlights", path.join(dir, "highlights.md"), "--out", out], run);
    assert.deepEqual(calls[0], ["api", "repos/RokaSwK/threebot/releases/generate-notes", "-f", "tag_name=v0.1.7", "-f", "previous_tag_name=v0.1.6", "--jq", ".body"]);
    assert.equal(calls[1][1], "graphql");
    assert.match(calls[1].join(" "), /pr1: pullRequest\(number: 1\).*pr6: pullRequest\(number: 6\)/);
    const body = await readFile(out, "utf8");
    // bob is a Bot by GitHub's answer; dependabot and renovate[bot] by name.
    assert.match(body, /^\*\*v0\.1\.7\*\* · 6 changes from 2 contributors\n/);
    assert.match(body, /### Plus 5 more changes\./);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
