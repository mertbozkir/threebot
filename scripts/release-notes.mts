#!/usr/bin/env node
// Writes a release's notes the way T3 Code's scripts/generate-release-notes.ts does, with highlights a
// person writes instead of a model's:
//
//   **v0.1.7** · 23 changes from 4 contributors
//
//   - **Label.** One sentence.
//
//   ### Plus 12 more changes.
//
//   <details>
//   <summary>Full changelog</summary>
//
//   (GitHub's "What's Changed" and "New Contributors")
//
//   </details>
//
// Usage (docs/self-hosting.md, "Releases"):
//   node scripts/release-notes.mts <previous tag> <new tag> [--highlights highlights.md] [--target <ref>] [--repo owner/name] [--out notes.md]
//
// It asks GitHub (through `gh`) for the generated notes between the two tags and for each PR's author,
// so the counts skip bots. The app (web/src/lib/releaseNotes.ts) reads this format.
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPO = "RokaSwK/threebot";
export const MAX_HIGHLIGHTS = 7;

export interface Change { title: string; login: string; number: number | null; url: string }
export interface Author { login: string; bot: boolean }
export interface Highlight { label: string; detail: string; prs: number[] }

/** Accounts that are apps rather than people, when GitHub's answer doesn't say. */
const KNOWN_BOTS = new Set(["dependabot", "renovate", "github-actions", "copilot", "copilot-swe-agent", "imgbot", "allcontributors", "snyk-bot", "greenkeeper"]);
export const looksLikeBot = (login: string) => /\[bot\]$/i.test(login) || KNOWN_BOTS.has(login.toLowerCase());

/** The `* title by @login in <url>` lines of GitHub's generated notes, in order. */
export function readChanges(generated: string): Change[] {
  const changes: Change[] = [];
  let inChanges = true;
  for (const raw of generated.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{1,6}\s+New Contributors/i.test(line)) { inChanges = false; continue; }
    if (/^#{1,6}\s/.test(line)) { inChanges = true; continue; }
    const m = /^[*-]\s+(.*\S)\s+by\s+@(\S+)\s+in\s+(\S+)$/.exec(line);
    if (!inChanges || !m) continue;
    const number = /\/pull\/(\d+)\b/.exec(m[3]);
    changes.push({ title: m[1], login: m[2], number: number ? Number(number[1]) : null, url: m[3] });
  }
  return changes;
}

/** People who authored a change: one each, bots left out. `authors` is GitHub's answer per PR number. */
export function countContributors(changes: Change[], authors: ReadonlyMap<number, Author> = new Map()): number {
  const people = new Set<string>();
  for (const change of changes) {
    const author = change.number === null ? undefined : authors.get(change.number);
    const login = author?.login ?? change.login;
    if (author?.bot || looksLikeBot(login) || looksLikeBot(change.login)) continue;
    people.add(login.toLowerCase());
  }
  return people.size;
}

/**
 * The highlights file: one `- **Label.** One sentence.` bullet each, at most seven. A bullet can end with
 * the PRs it covers, `(#12, #14)`; they're left out of the notes and those PRs out of "Plus N more".
 * Anything that isn't a bullet (a title, a comment) is ignored.
 */
export function readHighlights(text: string): Highlight[] {
  const highlights: Highlight[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^[-*]\s+/.test(line)) continue;
    let body = line.replace(/^[-*]\s+/, "");
    const refs = /\s*\(((?:#\d+(?:,\s*)?)+)\)\.?$/.exec(body);
    const prs = refs ? [...refs[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : [];
    if (refs) body = body.slice(0, refs.index).trimEnd();
    const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(body);
    if (!m) throw new Error(`A highlight needs a bold label: "- **Label.** One sentence." Got: ${line}`);
    const label = m[1].trim().replace(/\.$/, ""), detail = m[2].trim();
    if (!label || !detail) throw new Error(`A highlight needs a label and a sentence: ${line}`);
    highlights.push({ label, detail, prs });
  }
  if (highlights.length > MAX_HIGHLIGHTS) throw new Error(`Up to ${MAX_HIGHLIGHTS} highlights, like T3 Code; the file has ${highlights.length}.`);
  return highlights;
}

/**
 * "### Plus N more …" for the changes no highlight covers. Highlights that name their PRs cover those;
 * otherwise each highlight counts as one change. The kind follows T3 Code's wording when every
 * remaining title is a conventional `fix:` or `perf:`, and is "changes" otherwise.
 */
export function formatFooter(changes: Change[], highlights: Highlight[]): string | null {
  const named = new Set(highlights.flatMap((h) => h.prs));
  const remaining = named.size ? changes.filter((c) => c.number === null || !named.has(c.number)) : changes.slice(Math.min(highlights.length, changes.length));
  const unnamed = named.size ? highlights.filter((h) => !h.prs.length).length : 0;
  const count = Math.max(0, remaining.length - unnamed);
  if (!count) return null;
  const kinds = new Set(remaining.map((c) => /^(fix|perf)(?:\([^)]*\))?!?:/i.exec(c.title)?.[1]?.toLowerCase() ?? "other"));
  let kind = count === 1 ? "change" : "changes";
  if (!kinds.has("other")) {
    if (kinds.has("fix") && kinds.has("perf")) kind = "bug fixes and performance improvements";
    else if (kinds.has("fix")) kind = count === 1 ? "bug fix" : "bug fixes";
    else kind = count === 1 ? "performance improvement" : "performance improvements";
  }
  return highlights.length ? `### Plus ${count} more ${kind}.` : `**${count} ${kind}.**`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export const formatHeader = (version: string, changes: number, contributors: number) =>
  `**v${version.replace(/^v/, "")}** · ${plural(changes, "change")} from ${plural(contributors, "contributor")}`;

/** The whole release body. */
export function buildReleaseNotes({ version, generated, highlights = [], authors = new Map() }: { version: string; generated: string; highlights?: Highlight[]; authors?: ReadonlyMap<number, Author> }): string {
  const changes = readChanges(generated);
  const header = formatHeader(version, changes.length, countContributors(changes, authors));
  const bullets = highlights.map((h) => `- **${h.label}.** ${h.detail}`).join("\n");
  const footer = formatFooter(changes, highlights);
  const folded = `<details>\n<summary>Full changelog</summary>\n\n${generated.trim()}\n\n</details>\n`;
  return [header, bullets, footer, folded].filter(Boolean).join("\n\n");
}

type Gh = (args: string[]) => string;
const gh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/** GitHub's generated notes between two tags, the same text `gh release create --generate-notes` writes. */
export function generatedNotes({ repo, tag, previousTag, target, run = gh }: { repo: string; tag: string; previousTag: string; target?: string; run?: Gh }): string {
  const args = ["api", `repos/${repo}/releases/generate-notes`, "-f", `tag_name=${tag}`, "-f", `previous_tag_name=${previousTag}`, ...(target ? ["-f", `target_commitish=${target}`] : []), "--jq", ".body"];
  return run(args);
}

/** Each PR's author, asked 50 PRs at a time, so a bot account says it's one. */
export function pullRequestAuthors({ repo, numbers, run = gh }: { repo: string; numbers: number[]; run?: Gh }): Map<number, Author> {
  const [owner, name] = repo.split("/");
  const authors = new Map<number, Author>();
  const unique = [...new Set(numbers)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const fields = batch.map((n) => `pr${n}: pullRequest(number: ${n}) { author { __typename login } }`).join(" ");
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
    const reply = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`]));
    for (const n of batch) {
      const author = reply?.data?.repository?.[`pr${n}`]?.author;
      if (author?.login) authors.set(n, { login: author.login, bot: author.__typename === "Bot" });
    }
  }
  return authors;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("Usage: node scripts/release-notes.mts <previous tag> <new tag> [--highlights highlights.md] [--target <ref>] [--repo owner/name] [--out notes.md]");
  process.exit(2);
}

export function main(argv: string[], run: Gh = gh): string {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (!["highlights", "target", "repo", "out"].includes(key) || argv[i + 1] === undefined) usage(`Unknown or incomplete option: ${arg}`);
      flags[key] = argv[++i];
    } else positional.push(arg);
  }
  if (positional.length !== 2) usage();
  const [previousTag, tag] = positional;
  const repo = flags.repo ?? DEFAULT_REPO;
  const highlights = flags.highlights ? readHighlights(readFileSync(flags.highlights, "utf8")) : [];
  const generated = generatedNotes({ repo, tag, previousTag, target: flags.target, run });
  const changes = readChanges(generated);
  const authors = pullRequestAuthors({ repo, numbers: changes.flatMap((c) => c.number ?? []), run });
  const body = buildReleaseNotes({ version: tag, generated, highlights, authors });
  if (flags.out) {
    // Write next to it, then rename: `gh release edit --notes-file` never reads half a file.
    writeFileSync(`${flags.out}.tmp`, body);
    renameSync(`${flags.out}.tmp`, flags.out);
  } else process.stdout.write(body);
  return body;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
}
