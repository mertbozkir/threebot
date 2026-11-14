// What's new in a release, the way T3 Code's update popover shows it: the header line, the highlights,
// "Plus N more…", the full changelog with each change's author, the contributors and a link to GitHub.
// Everything comes from parseReleaseNotes as plain text and is rendered as text.
import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, ExternalLink } from "lucide-react";
import { avatarUrl, parseReleaseNotes, profileUrl, type ReleaseNotes } from "../lib/releaseNotes";
import { timeAgo } from "../lib/projects";

export interface ReleaseSummary { version: string; url: string; notes: string; publishedAt: string | null }

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

/** A GitHub profile picture, loaded when it scrolls into view, with the login's first letter until then or if it fails. */
export function GitHubAvatar({ login, size = 20, className }: { login: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  return <span aria-hidden="true" className={clsx("release-avatar relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-hover font-medium text-muted", className)} style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>
    {login[0]?.toUpperCase()}
    {!failed && <img src={avatarUrl(login)} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
  </span>;
}

function Contributors({ logins, total }: { logins: string[]; total: number }) {
  if (!logins.length) return null;
  return <div className="release-contributors mt-3 flex flex-wrap items-center gap-1.5" aria-label="Contributors">
    {logins.map((login) => <a key={login} href={profileUrl(login)} {...external} title={`@${login}`} aria-label={`@${login} on GitHub`} className="rounded-full outline-offset-2 transition-opacity hover:opacity-80">
      <GitHubAvatar login={login} size={24} />
    </a>)}
    {total > logins.length && <span className="text-[12px] text-muted">+{total - logins.length}</span>}
  </div>;
}

function Changelog({ notes, url }: { notes: ReleaseNotes; url: string }) {
  if (!notes.changes.length) return null;
  const hidden = notes.totalChanges - notes.changes.length;
  return <details className="release-changelog group mt-3 border-t border-line pt-2">
    <summary className="flex cursor-pointer list-none items-center gap-1 py-1 text-[12.5px] font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
      <ChevronRight size={14} aria-hidden="true" className="transition-transform group-open:rotate-90" />
      Full changelog <span className="font-normal">· {notes.totalChanges}</span>
    </summary>
    <ul className="mt-1 space-y-2 pb-1">
      {notes.changes.map((change, i) => <li key={i} className="flex min-w-0 items-start gap-2 text-[12.5px] leading-[18px]">
        {change.author ? <GitHubAvatar login={change.author} size={18} className="mt-px" /> : <span className="size-[18px] shrink-0" />}
        <span className="min-w-0 flex-1 break-words">
          {change.url ? <a href={change.url} {...external} className="hover:underline">{change.title}</a> : change.title}
          {change.author && <> <a href={profileUrl(change.author)} {...external} className="text-muted hover:text-fg hover:underline">@{change.author}</a></>}
        </span>
      </li>)}
    </ul>
    {hidden > 0 && <p className="pb-1 pl-[26px] text-[12px] text-muted"><a href={url} {...external} className="hover:underline">{hidden} more on GitHub</a></p>}
  </details>;
}

/**
 * One release's notes. `title` goes before the header line ("What's new", "Your version"); an empty body
 * still shows the version and the GitHub link.
 */
export function ReleaseNotesView({ release, title, className }: { release: ReleaseSummary; title?: string; className?: string }) {
  const notes = useMemo(() => parseReleaseNotes(release.notes), [release.notes]);
  return <section className={clsx("release-notes min-w-0 text-[13px]", className)} aria-label={`Release notes for v${release.version}`}>
    {title && <div className="mb-1 text-[12.5px] text-muted">{title}</div>}
    <p className="release-header flex flex-wrap items-baseline gap-x-1.5 text-[13.5px]">
      <span className="font-semibold">v{release.version}</span>
      {notes.stats && <span className="text-muted">· {notes.stats}</span>}
      {release.publishedAt && <span className="text-[12px] text-muted">· {timeAgo(release.publishedAt)}</span>}
    </p>
    {notes.highlights.length > 0 && <ul className="release-highlights mt-2.5 space-y-1.5">
      {notes.highlights.map((h, i) => <li key={i} className="relative pl-3.5 leading-[19px] before:absolute before:left-0 before:top-[8px] before:size-1 before:rounded-full before:bg-muted">
        {h.label && <span className="font-semibold">{h.label}. </span>}<span className={h.label ? "text-fg/85" : undefined}>{h.text}</span>
      </li>)}
    </ul>}
    {notes.footer && <p className="release-footer mt-2.5 text-[12.5px] text-muted">{notes.footer}</p>}
    <Contributors logins={notes.contributors} total={notes.totalContributors} />
    <Changelog notes={notes} url={release.url} />
    <a href={release.url} {...external} className="release-github mt-3 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg hover:underline">View on GitHub<ExternalLink size={12} aria-hidden="true" /></a>
  </section>;
}
