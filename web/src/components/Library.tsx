import { useEffect, useMemo, useState } from "react";
import { FileText, Globe, Image, Video, PanelsTopLeft, Library as LibraryIcon } from "lucide-react";
import clsx from "clsx";
import { useApp, watchThread } from "../store";
import { botLibraryDir, conversationLibrary, filterLibraryEntries, libraryAge, libraryGroups, mergeLibraryEntries, workspaceListingEntries, type LibraryEntry } from "../lib/library";
import { listLibraryFiles, isLibraryPage } from "../lib/librarySearch";
import { workspaceFileKind } from "../lib/workspaceLinks";
import { workspaceClient } from "../lib/workspaceTransport";
import { workspaceAssetUrl } from "../lib/workspaceAssets";
import { WorkspaceResourceViewer } from "./WorkspaceResource";
import type { Bot } from "../lib/types";

export function Library({ bot }: { bot: Bot }) {
  const [filter, setFilter] = useState("All");
  const [files, setFiles] = useState<LibraryEntry[] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<Exclude<LibraryEntry, { kind: "link" }> | null>(null);
  const [error, setError] = useState(false);
  const data = useApp((s) => bot.mainThreadId ? s.threadData[bot.mainThreadId] : undefined);
  useEffect(() => { try { workspaceClient(bot.mainThreadId); return bot.mainThreadId ? watchThread(bot.mainThreadId, false) : undefined; } catch { return undefined; } }, [bot.mainThreadId]);
  useEffect(() => {
    setFiles(null); setError(false);
    let live = true;
    const workspace = { workspaceRoot: bot.workspaceRoot, threadId: bot.mainThreadId, libraryDir: botLibraryDir(bot) };
    Promise.resolve().then(() => listLibraryFiles(workspace)).then((result) => {
      const entries = workspaceListingEntries(result, workspace);
      if (live) setFiles(entries);
    }).catch(() => { if (live) { setError(true); setFiles([]); } });
    return () => { live = false; };
  }, [bot.workspaceRoot, bot.mainThreadId, bot.adopted, attempt]);
  useEffect(() => { setOpened(null); }, [bot.workspaceRoot, bot.mainThreadId]);
  const items = useMemo(() => conversationLibrary(Object.values(data?.items ?? {}), { workspaceRoot: bot.workspaceRoot, threadId: bot.mainThreadId, libraryDir: botLibraryDir(bot) }), [data?.items, bot.workspaceRoot, bot.mainThreadId, bot.adopted]);
  const source = mergeLibraryEntries(items, files ?? []);
  const visible = filterLibraryEntries(source, filter);
  return <div className="library-view">
    <div className="library-filters mb-5 flex gap-2" role="tablist" aria-label="Library filters">{["All", "Pages", "Media", "Links", "Files"].map((name) => <button key={name} role="tab" aria-selected={filter === name} onClick={() => setFilter(name)} className={clsx("shrink-0 rounded-full px-3 py-2 text-[14px]", filter === name ? "bg-pill text-pill-fg" : "bg-active text-fg")}>{name}</button>)}</div>
    {libraryGroups(visible).map(group => <section key={group.label} className="library-time-group">
      {group.label && <h3 className="mb-2 px-4 text-[14px] font-normal text-faint">{group.label}</h3>}
      <div className="library-list overflow-hidden rounded-[20px] bg-card px-4">
        {group.entries.map((item) => {
          const age = libraryAge(item.at);
          const content = <><span className="grid size-6 shrink-0 place-items-center text-muted">{isLibraryPage(item) ? <PanelsTopLeft size={20} /> : item.kind === "link" ? <Globe size={20} /> : item.kind === "media" ? <LibraryThumbnail item={item} threadId={bot.mainThreadId} /> : <FileText size={20} />}</span><span className="min-w-0 flex-1"><span className="block truncate text-[14px]">{item.title}</span><span className="mt-1 block truncate text-[12px] text-muted">{isLibraryPage(item) ? <><span>Canvas</span>{" · "}<span>Private</span></> : item.detail === "Workspace file" ? "File" : item.detail}{item.kind !== "link" && age && ` · ${age}`}</span></span></>;
          const row = "library-row flex w-full items-center gap-3 border-b border-line py-4 text-left last:border-0 hover:bg-hover";
          return item.kind === "link" ? <a key={item.id} className={row} href={item.href} target="_blank" rel="noreferrer">{content}</a> : <button key={item.id} className={row} onClick={() => setOpened(item)}>{content}</button>;
        })}
      </div>
    </section>)}
    {files === null ? <div className="py-6 text-center text-[13px] text-muted">Loading…</div> : !visible.length ? <div className="rounded-2xl bg-card px-5 py-10 text-center text-[14px] text-muted"><LibraryIcon size={26} className="mx-auto mb-3" />{filter === "All" ? `Files and Pages shared with ${bot.name} appear here.` : `No ${filter.toLowerCase()} yet.`}</div> : null}
    {error && <p role="status" className="mt-3 text-[13px] text-muted">Couldn't load workspace files. Conversation links and attachments are still available. <button className="underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>}
    {opened && <WorkspaceResourceViewer scopeThreadId={bot.mainThreadId} resource={opened.resource} title={opened.title} fileKind={opened.kind === "media" ? opened.detail === "Video" ? "video" : "image" : undefined} onClose={() => setOpened(null)} />}
  </div>;
}

function LibraryThumbnail({ item, threadId }: { item: Exclude<LibraryEntry, { kind: "link" }>; threadId: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const resourceKey = JSON.stringify(item.resource);
  const video = item.detail === "Video" || workspaceFileKind(item.title) === "video";
  useEffect(() => {
    let live = true;
    setUrl(null); setFailed(false);
    void workspaceAssetUrl(item.resource, threadId).then(url => { if (live) setUrl(url); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [resourceKey, threadId]);
  if (!url || failed) return video ? <Video size={20} /> : <Image size={20} />;
  const props = { src: url, className: "size-6 rounded-md object-cover", onError: () => setFailed(true) };
  return video ? <video {...props} muted playsInline preload="metadata" aria-hidden="true" /> : <img {...props} alt="" loading="lazy" />;
}
