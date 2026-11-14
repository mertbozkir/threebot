// Narrow windows and touch devices both need tap-only keyboard activation.
export const MOBILE_CHAT_QUERY = "(max-width: 760px), (pointer: coarse)";

type ComposerTarget = Pick<HTMLTextAreaElement, "readOnly" | "focus" | "blur">;

/** Keep focus restoration from overlays from reopening the software keyboard. */
export function composerFocusBehavior(requiresTap: boolean) {
  let state: "idle" | "tapped" | "editing" = "idle";
  return {
    onEntry(target: ComposerTarget | null) {
      state = "idle";
      if (!target) return;
      target.readOnly = requiresTap;
      if (requiresTap) target.blur();
      else target.focus();
    },
    onPointerDown(target: ComposerTarget) {
      if (!requiresTap) return;
      if (state !== "editing") state = "tapped";
      // This must happen before the pointer's default focus action, including on iOS.
      target.readOnly = false;
    },
    onClick(target: ComposerTarget) {
      // Screen readers and accessibility automation can activate with click
      // alone. Read-only tap protection must not strand those users.
      if (!requiresTap || state === "editing") return;
      state = "tapped";
      target.readOnly = false;
      target.focus();
    },
    onFocus(target: ComposerTarget) {
      if (requiresTap && state === "idle") {
        state = "idle";
        target.readOnly = true;
        target.blur();
        return;
      }
      state = "editing";
    },
    onBlur(target: ComposerTarget) {
      state = "idle";
      target.readOnly = requiresTap;
    },
    onPointerCancel(target: ComposerTarget) {
      if (state !== "tapped") return;
      state = "idle";
      if (requiresTap) target.readOnly = true;
    },
  };
}

/** Snapshot before resetting so the same file can be picked again after removal. */
export function takeAttachmentFiles(input: Pick<HTMLInputElement, "files" | "value">): File[] {
  const files = Array.from(input.files ?? []);
  input.value = "";
  return files;
}

export function splitBubbles(text: string): string[] {
  // Block Markdown must reach its parser intact, including unfinished streamed
  // blocks. Keep the original bytes rather than splitting at internal blank lines.
  if (text.length > 900 || /```|~~~|\$\$|\\\[|\n\|/.test(text)) return [text];
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  // Keep lists attached to the sentence that introduces them.
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && (/^([-*]|\d+\.)\s/.test(p) || /:$/.test(out[out.length - 1]))) out[out.length - 1] += "\n\n" + p;
    else out.push(p);
  }
  return out.length > 4 ? [text] : out;
}

/** `/clear` on its own starts a fresh session with the next message, as in T3 Code. */
export function isClearCommand(text: string) {
  return /^\/clear\s*$/i.test(text.trim());
}

// "- ", "* ", "+ ", "1. ", "1) ", optionally followed by a task box, after any indent.
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+(?:\[[ xX]\][ \t]+)?/;

/**
 * A new line inside a Markdown list item: continue the list, or end it on an empty item.
 * Returns the range to replace and its new text, or null when the line is not a list item.
 * The text stays plain Markdown, so what you type is what is sent.
 */
export function listNewline(value: string, start: number, end = start): { from: number; to: number; insert: string } | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const newline = value.indexOf("\n", start);
  const lineEnd = newline === -1 ? value.length : newline;
  const line = value.slice(lineStart, lineEnd);
  const match = LIST_ITEM.exec(line);
  if (!match || start < lineStart + match[0].length) return null;
  // Enter on an empty item ends the list and leaves an empty line.
  if (!line.slice(match[0].length).trim()) return { from: lineStart, to: lineEnd, insert: "" };
  const [, indent, bullet, number, delimiter] = match;
  const task = /\[[ xX]\]/.test(match[0]) ? "[ ] " : "";
  const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
  return { from: start, to: end, insert: `\n${indent}${marker} ${task}` };
}
