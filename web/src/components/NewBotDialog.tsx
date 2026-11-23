import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderGit2, Pencil } from "lucide-react";
import { Avatar } from "./Avatar";
import { AvatarEditorDialog, AvatarPicker, type AvatarDraft } from "./AvatarEditor";
import { Modal, Pill, Spinner } from "./ui";
import { createBot, defaultModel, deleteBot, ensureBotSection, openDialog, releaseBot, toast, updateBot, useApp } from "../store";
import { DEFAULT_AVATAR } from "../lib/character";
import { sharedObjects } from "../lib/objectAvatars";
import type { Bot } from "../lib/types";
import { useAvatarDrawing } from "./useAvatarDrawing";
import { composeBotInstructions, BOT_INSTRUCTIONS_MAX } from "../lib/botInstructions";

export { AvatarPicker } from "./AvatarEditor";

const SECTION_PREFIX = "section:";

export function NewBotDialog() {
  const bots = useApp((s) => s.bots);
  const sections = useApp((s) => s.settings?.sections);
  const first = Object.keys(bots).length === 0;
  const [name, setName] = useState(first ? "Threebot" : "");
  const [sectionChoice, setSectionChoice] = useState("");
  const [sectionName, setSectionName] = useState("");
  const [label, setLabel] = useState("");
  const [does, setDoes] = useState("");
  const [doesNot, setDoesNot] = useState("");
  const [style, setStyle] = useState("");
  const [avatar, setAvatar] = useState<AvatarDraft>({ ...DEFAULT_AVATAR });
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => openDialog(null);
  const instructions = composeBotInstructions({ does, doesNot, style });
  const tooLong = instructions.length > BOT_INSTRUCTIONS_MAX;
  const newSection = sectionChoice === "new";
  const canCreate = name.trim() && (!newSection || sectionName.trim()) && !busy && !tooLong;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      const section = newSection ? await ensureBotSection(sectionName) : sectionChoice.slice(SECTION_PREFIX.length) || null;
      await createBot({
        name: name.trim(), label: label.trim(), section, instructions, ...avatar, model: defaultModel(), primary: first,
      });
      if (first) await updateBot(Object.values(useApp.getState().bots)[0].slug, { pinned: true });
      close();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the Bot");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} title="Create New Bot" className="new-bot-sheet w-[440px]">
      <div className="dialog-body">
        <div className="new-bot-preview flex flex-col items-center px-5 pt-5">
          <button type="button" aria-label="Edit Bot avatar" onClick={() => setPicker(true)}><Avatar {...avatar} picture={avatar.avatarImage} definition={avatar.avatarDefinition} size={184} state="idle" /></button>
          <input
            aria-label="Name your Bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Name your Bot"
            className="new-bot-name mt-4 h-10 w-full rounded-xl border border-line bg-transparent text-center text-[14px] outline-none placeholder:text-faint focus:border-line-strong"
          />
          <span className="relative mt-2 block w-full">
          <select aria-label="Section" value={sectionChoice} disabled={busy} onChange={(e) => setSectionChoice(e.target.value)} className="new-bot-section h-9 w-full rounded-xl border border-line px-9 text-[14px] outline-none focus:border-line-strong">
            <option value="">Unassigned</option>
            {sections?.map((section) => <option key={section} value={SECTION_PREFIX + section}>{section}</option>)}
            <option value="new">New section…</option>
          </select>
          <ChevronDown size={16} aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
          </span>
          {newSection && <input
            aria-label="Section name"
            placeholder="Section name"
            value={sectionName}
            disabled={busy}
            onChange={(e) => setSectionName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            className="mt-2 h-9 w-full rounded-xl border border-line bg-transparent px-3 text-[13px] outline-none placeholder:text-faint focus:border-line-strong"
          />}
          <input
            aria-label="What is this Bot for?"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="What is this Bot for? (optional)"
            className="new-bot-role mt-1 h-8 w-full border-0 bg-transparent text-center text-[13px] text-muted outline-none placeholder:text-faint focus:text-fg"
          />
          <p className="new-bot-role-hint mt-0.5 text-center text-[11.5px] text-muted">One line. It appears under the Bot's name.</p>
        </div>
        <details className="new-bot-more mx-5 mt-2 rounded-xl border border-line bg-card">
          <summary className="new-bot-more-summary flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[13.5px] text-fg [&::-webkit-details-marker]:hidden">
            <ChevronRight size={14} className="new-bot-more-chevron transition-transform text-muted" /> Add more detail
            <span className="ml-auto text-[12px] font-normal text-muted">Optional</span>
          </summary>
          <div className="space-y-3 border-t border-line px-3 py-3">
            <label className="block text-[12.5px] text-muted">What should it do?
              <textarea value={does} maxLength={BOT_INSTRUCTIONS_MAX} onChange={(e) => setDoes(e.target.value)} rows={2} placeholder="Review code changes and tell me what blocks a merge." className="mt-1 w-full rounded-xl border border-line bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-line-strong" />
            </label>
            <label className="block text-[12.5px] text-muted">What should it not do?
              <textarea value={doesNot} maxLength={BOT_INSTRUCTIONS_MAX} onChange={(e) => setDoesNot(e.target.value)} rows={2} placeholder="Don't touch the billing settings." className="mt-1 w-full rounded-xl border border-line bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-line-strong" />
            </label>
            <label className="block text-[12.5px] text-muted">How should it talk to you?
              <input value={style} maxLength={BOT_INSTRUCTIONS_MAX} onChange={(e) => setStyle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Spanish, direct, technical." className="mt-1 h-9 w-full rounded-xl border border-line bg-transparent px-3 text-[13px] outline-none placeholder:text-faint focus:border-line-strong" />
            </label>
            <div className="flex items-center gap-2 text-[11.5px] text-muted">
              <span>You can change all of this later in Details › Instructions.</span>
              {instructions.length > BOT_INSTRUCTIONS_MAX * 0.9 && <span className={tooLong ? "ml-auto shrink-0 text-danger" : "ml-auto shrink-0"}>{instructions.length.toLocaleString()} / {BOT_INSTRUCTIONS_MAX.toLocaleString()}</span>}
            </div>
            {tooLong && <p role="alert" className="text-[12px] text-danger">These details are too long. Shorten them to {BOT_INSTRUCTIONS_MAX.toLocaleString()} characters or fewer.</p>}
          </div>
        </details>
        <AvatarPicker shape={avatar.shape} color={avatar.color} disabled={busy} onChange={(shape, color) => setAvatar({ shape, color, avatarImage: null, avatarDefinition: shape === avatar.shape ? avatar.avatarDefinition : null })} />
      </div>
      <div className="dialog-footer flex items-center gap-2 border-t border-line px-3 py-3">
        <Pill onClick={create} disabled={!canCreate}>
          {busy && <Spinner />} Create
        </Pill>
        <button type="button" disabled={busy} onClick={() => openDialog("adopt-project")} className="new-bot-from-project ml-auto flex h-9 items-center gap-2 rounded-full px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">
          <FolderGit2 size={15} /> From an existing project
        </button>
      </div>
      {picker && <AvatarEditorDialog initial={avatar} onSave={async draft => { setAvatar(draft); }} onClose={() => setPicker(false)} />}
    </Modal>
  );
}

export function RenameBotDialog({ slug }: { slug: string }) {
  const bot = useApp((s) => s.bots[slug]);
  const [name, setName] = useState(bot?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [avatar, setAvatar] = useState<AvatarDraft>({ shape: bot?.shape ?? DEFAULT_AVATAR.shape, color: bot?.color ?? DEFAULT_AVATAR.color, avatarImage: bot?.avatarImage, avatarDefinition: bot?.avatarDefinition });
  const [picker, setPicker] = useState(false);
  const close = () => openDialog(null);
  if (!bot) return null;
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await updateBot(slug, { name: name.trim(), ...avatar });
      close();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't rename the Bot");
      setBusy(false);
    }
  };
  return (
    <Modal onClose={close} onBack={close} title="Edit Bot" className="edit-bot-sheet w-[380px]" headerActions={<Pill onClick={save} disabled={busy || !name.trim()}>Done</Pill>}>
      <div className="edit-bot-body dialog-body p-4">
        <button type="button" className="edit-bot-avatar relative mx-auto mb-5 block" aria-label="Edit Bot avatar" onClick={() => setPicker(true)}><Avatar {...avatar} picture={avatar.avatarImage} definition={avatar.avatarDefinition} size={88} /><span className="absolute -right-2 -bottom-2 grid size-10 place-items-center rounded-full border border-line bg-elevated"><Pencil size={20} /></span></button>
        <label className="edit-bot-label block text-muted" htmlFor="edit-bot-name">Name</label>
        <input id="edit-bot-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} autoComplete="off" className="edit-bot-name h-10 w-full rounded-xl border border-line bg-transparent px-3 text-[14px] outline-none focus:border-line-strong" />
        <p className="edit-bot-label text-muted">Appearance</p>
        <button type="button" className="edit-bot-appearance flex w-full items-center justify-between rounded-2xl bg-card p-4 text-left" onClick={() => setPicker(true)}>Avatar<ChevronRight size={20} className="text-muted" /></button>
      </div>
      {picker && <BotAvatarEditor bot={bot} initial={avatar} onSave={async draft => { setAvatar(draft); }} onClose={() => setPicker(false)} />}
      <div className="edit-bot-footer flex justify-end gap-2 p-3"><Pill variant="soft" onClick={close}>Cancel</Pill></div>
    </Modal>
  );
}

/** An existing Bot's avatar editor, as in its details: with the objects other Bots drew and "Draw a new object". */
function BotAvatarEditor({ bot, initial, onSave, onClose }: { bot: Bot; initial: AvatarDraft; onSave: (draft: AvatarDraft) => Promise<void>; onClose: () => void }) {
  const bots = useApp((s) => s.bots);
  const shared = useMemo(() => sharedObjects(Object.values(bots)), [bots]);
  const draw = useAvatarDrawing(bot);
  return <AvatarEditorDialog initial={initial} onSave={onSave} onClose={onClose} shared={shared} draw={draw} />;
}

export function DeleteBotDialog({ slug }: { slug: string }) {
  const bot = useApp((s) => s.bots[slug]);
  const [busy, setBusy] = useState(false);
  const close = () => openDialog(null);
  if (!bot) return null;
  if (bot.adopted) return <ReleaseBotDialog slug={slug} />;
  return (
    <Modal onClose={close} className="w-[400px]">
      <div className="p-5">
        <div className="text-[15px] font-semibold">Delete {bot.name}?</div>
        <p className="mt-2 text-[13.5px] text-muted">This erases its conversation, memory and routines. Its folder is moved to the trash on the server.</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-3">
        <Pill variant="soft" onClick={close}>Cancel</Pill>
        <Pill
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await deleteBot(slug);
              close();
            } catch (error) {
              toast(error instanceof Error ? error.message : "Couldn't delete the Bot");
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />} Delete
        </Pill>
      </div>
    </Modal>
  );
}

/** A Bot made from a project goes back to being that project: nothing of the project is deleted. */
export function ReleaseBotDialog({ slug }: { slug: string }) {
  const bot = useApp((s) => s.bots[slug]);
  const [busy, setBusy] = useState(false);
  const close = () => openDialog(null);
  if (!bot) return null;
  return (
    <Modal onClose={close} className="release-bot-sheet w-[420px]">
      <div className="p-5">
        <div className="text-[15px] font-semibold">Turn {bot.name} back into a plain project?</div>
        <p className="mt-2 text-[13.5px] text-muted">The project, its T3 threads and its git history stay exactly as they are. The Bot's instructions and settings files leave the folder, and its memory and library are archived on the server, not deleted.</p>
        <p className="mt-2 truncate font-mono text-[12px] text-muted" title={bot.workspaceRoot}>{bot.workspaceRoot}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-3">
        <Pill variant="soft" onClick={close}>Cancel</Pill>
        <Pill
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await releaseBot(slug);
              toast(`${bot.name} is a plain project again`);
              close();
            } catch (error) {
              toast(error instanceof Error ? error.message : "Couldn't turn the Bot back into a project");
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />} Turn back
        </Pill>
      </div>
    </Modal>
  );
}
