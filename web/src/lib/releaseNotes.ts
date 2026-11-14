// Reads a GitHub release body into what the app shows about a release, the way T3 Code's update
// popover does (apps/desktop/src/updates/releaseNotes.ts). Two shapes come in:
//
// - scripts/release-notes.mts's: a header (`**v0.1.7** · 23 changes from 4 contributors`), up to 7
//   `- **Label.** Sentence.` highlights, `### Plus N more …`, then GitHub's list under
//   `<details><summary>Full changelog</summary>`.
// - GitHub's own generated notes: `## What's Changed`, `* title by @login in <PR url>`, `## New Contributors`.
//
// A release body is untrusted text. Everything here comes out as plain strings with markup stripped,
// logins checked against GitHub's rules and links limited to github.com, and the app renders them as
// text, never as HTML.

export interface ReleaseHighlight { label: string | null; text: string }
export interface ReleaseChange { title: string; author: string | null; url: string | null }
export interface ReleaseNotes {
  /** The stats after the version in the header: "23 changes from 4 contributors". Counted from the list when the body has no header. */
  stats: string | null;
  highlights: ReleaseHighlight[];
  /** "Plus 12 more bug fixes and performance improvements." */
  footer: string | null;
  /** Newest first, as GitHub lists them, at most MAX_CHANGES. */
  changes: ReleaseChange[];
  /** How many changes the body lists, including those past MAX_CHANGES. */
  totalChanges: number;
  /** People (no bots) who authored a change or are named as new contributors, in order of appearance. */
  contributors: string[];
  /** How many people that is, including those past MAX_CONTRIBUTORS. */
  totalContributors: number;
  newContributors: string[];
}

export const MAX_HIGHLIGHTS = 7;
export const MAX_CHANGES = 100;
export const MAX_CONTRIBUTORS = 30;
const MAX_ITEM_LENGTH = 220;
// Bodies past this are cut before parsing; GitHub caps a release body at 125,000 characters.
const MAX_BODY_LENGTH = 125_000;

const ENTITIES: ReadonlyMap<string, string> = new Map([["amp", "&"], ["apos", "'"], ["gt", ">"], ["lt", "<"], ["nbsp", " "], ["quot", '"']]);
function decodeEntities(input: string): string {
  return input.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (whole, entity: string) => {
    const named = ENTITIES.get(entity);
    if (named) return named;
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : entity.startsWith("#") ? Number.parseInt(entity.slice(1), 10) : NaN;
    // No control characters: they'd only hide text.
    return Number.isInteger(code) && code >= 0x20 && code <= 0x10ffff && !(code >= 0x7f && code < 0xa0) ? String.fromCodePoint(code) : whole;
  });
}

/** HTML and Markdown links down to text. Tags go before entities are decoded, so `&lt;script&gt;` stays text. */
function stripMarkup(input: string): string {
  return decodeEntities(input
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template|iframe|object|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote|summary|details)>/gi, "\n")
    .replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**")
    .replace(/<[^>]*>/g, "")
    // A link's target may hold one level of parentheses: [x](javascript:alert(1)).
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))+\)/g, "$1"))
    // Leftover angle brackets from a broken tag, and invisible direction overrides.
    .replace(/[<>]/g, "")
    .replace(/[‪-‮⁦-⁩]/g, "");
}

const clip = (text: string) => text.length <= MAX_ITEM_LENGTH ? text : `${text.slice(0, MAX_ITEM_LENGTH - 1).trimEnd()}…`;
const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

/** GitHub's username rules: letters, digits and single hyphens, up to 39 characters; apps end in [bot]. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
export const validLogin = (login: string) => LOGIN.test(login);
/** Accounts that are apps rather than people, so they don't count as contributors. */
const BOTS = new Set(["dependabot", "renovate", "github-actions", "copilot", "copilot-swe-agent", "imgbot", "allcontributors", "snyk-bot", "greenkeeper"]);
export const isBot = (login: string) => /\[bot\]$/i.test(login) || BOTS.has(login.toLowerCase());

/** Only https links on github.com, so a release body can't send you somewhere else. */
function githubUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** `title by @login in https://github.com/o/r/pull/1`, GitHub's line for a merged PR. */
const CHANGE = /^(.*\S)\s+by\s+@(\S+)\s+in\s+(\S+)\s*$/;
const NEW_CONTRIBUTOR = /^@(\S+)\s+made their first contribution\b/;

function readChanges(lines: string[]) {
  const changes: ReleaseChange[] = [];
  const newContributors: string[] = [];
  // Every change's author, also those past MAX_CHANGES, for the count of people.
  const authors: string[] = [];
  let total = 0, section: "changes" | "new" | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const name = plain(heading[1]).toLowerCase();
      section = name.startsWith("new contributors") ? "new" : "changes";
      continue;
    }
    if (/^full changelog\b/i.test(plain(line))) { section = null; continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const item = bullet[1].trim();
    if (section === "new") {
      const m = NEW_CONTRIBUTOR.exec(item);
      if (m && validLogin(m[1]) && !isBot(m[1])) newContributors.push(m[1]);
      continue;
    }
    total++;
    const m = CHANGE.exec(item);
    const author = m && validLogin(m[2]) ? m[2] : null;
    if (author) authors.push(author);
    if (changes.length >= MAX_CHANGES) continue;
    const title = clip(plain(m ? m[1] : item));
    if (title) changes.push({ title, author, url: m ? githubUrl(m[3]) : null });
  }
  return { changes, total, authors, newContributors };
}

/** The header, highlights and footer above `<details>`. */
function readSummary(lines: string[]) {
  let version: string | null = null, stats: string | null = null, footer: string | null = null;
  const highlights: ReleaseHighlight[] = [];
  for (const raw of lines) {
    const line = raw.trim().replace(/\s+/g, " ");
    const flat = plain(line);
    if (!flat) continue;
    const plus = /^#{1,6}\s+(Plus \d+ more .*)$/.exec(line);
    if (plus) { footer = clip(plain(plus[1])); continue; }
    if (/^#{1,6}\s/.test(line)) continue;
    const header = /^(v\d[\w.-]*) · (.+)$/.exec(flat);
    if (!version && header) { version = header[1]; stats = clip(header[2]); continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!bullet || highlights.length >= MAX_HIGHLIGHTS) continue;
    // `**Label.** Sentence.`, with any `(#12)` PR references dropped as T3 does.
    const body = bullet[1].replace(/\s*\((?:#\d+(?:,\s*)?)+\)\.?$/, "");
    const labelled = /^\*\*([^*]+?)\*\*\s*(.*)$/.exec(body);
    const label = labelled ? clip(plain(labelled[1]).replace(/[.:]$/, "")) : null;
    const text = clip(plain(labelled ? labelled[2] : body));
    if (label || text) highlights.push({ label: label || null, text });
  }
  return { version, stats, footer, highlights };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function parseReleaseNotes(body: unknown): ReleaseNotes {
  const empty: ReleaseNotes = { stats: null, highlights: [], footer: null, changes: [], totalChanges: 0, contributors: [], totalContributors: 0, newContributors: [] };
  if (typeof body !== "string" || !body.trim()) return empty;
  const text = body.slice(0, MAX_BODY_LENGTH).replace(/\r\n?/g, "\n");
  // Our notes fold GitHub's list under this exact <details> block; above it is the summary.
  const fold = text.search(/<details>\s*<summary>\s*Full changelog\s*<\/summary>/i);
  const summary = fold >= 0 ? readSummary(stripMarkup(text.slice(0, fold)).split("\n")) : null;
  const { changes, total, authors, newContributors } = readChanges(stripMarkup(fold >= 0 ? text.slice(fold) : text).split("\n"));
  const people = new Set<string>();
  for (const login of [...authors, ...newContributors]) if (!isBot(login)) people.add(login);
  const contributors = [...people].slice(0, MAX_CONTRIBUTORS);
  const stats = summary?.stats ?? (total ? `${plural(total, "change")} from ${plural(people.size, "contributor")}` : null);
  return { stats, highlights: summary?.highlights ?? [], footer: summary?.footer ?? null, changes, totalChanges: total, contributors, totalContributors: people.size, newContributors };
}

/** A GitHub profile picture, small. GitHub redirects this to the avatar CDN. */
export const avatarUrl = (login: string) => `https://github.com/${encodeURIComponent(login.replace(/\[bot\]$/i, ""))}.png?size=40`;
export const profileUrl = (login: string) => /\[bot\]$/i.test(login) ? `https://github.com/apps/${encodeURIComponent(login.replace(/\[bot\]$/i, ""))}` : `https://github.com/${encodeURIComponent(login)}`;
