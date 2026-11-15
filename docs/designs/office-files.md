# Office files: preview and basic editing

Status: Draft (Elephant), not reviewed
Date: 2026-11-15

## Goal

Bots already write `.xlsx` and `.docx` files into their workspace. Today the
file viewer can't show them and falls back to "Couldn't open this file". This
adds:

1. **Preview**: read-only view of sheets (cell grid, one tab per sheet) and of
   Word documents (headings, paragraphs, lists, tables, images).
2. **Basic editing**: change a cell's value in a sheet, and change the text of a
   paragraph in a document, then save back to the same file.

Anything the editor doesn't understand stays exactly as it was in the file.

## Non-goals

- A full Office suite: no formatting toolbar, no inserting rows, columns,
  tables, images or pages, no formula editing, no charts.
- Editing `.xls`, `.doc`, `.pptx` or `.odt`. These get the original-file link only.
- Editing files of Bots on a linked machine (see "Where saving works").
- Live collaboration or merging two people's edits.

## How editing keeps everything else intact

An `.xlsx` or `.docx` file is a zip of XML parts. Converting the file to another
model and back (for example, with a spreadsheet library's writer) can drop styles,
formulas, comments, drawings, revisions or extensions it doesn't know. So the
editor never rebuilds the file. It patches the few XML nodes the user changed
and copies every other zip entry byte for byte.

- **XLSX cell edit**: find `<c r="B4">` in `xl/worksheets/sheetN.xml`. Only cells
  whose value is a plain number, inline string or shared string are editable. A
  cell with a formula (`<f>`), a rich-text shared string, or a data type the editor
  doesn't handle is shown read-only with a short reason. The new value is written
  as an inline string (`t="inlineStr"`) or a number. The shared string table is
  never rewritten, so other cells keep their strings. The calc chain isn't touched;
  `<calcPr fullCalcOnLoad="1">` is set so Excel recalculates formulas that depend
  on the edited cell.
- **DOCX paragraph edit**: a paragraph is editable only if all its text runs share
  one run format and it has no fields, tracked changes, comments, hyperlinks,
  content controls or drawings. The edit replaces the text of the first `<w:t>`,
  removes the other runs' text, and keeps the paragraph and run properties. Other
  paragraphs are shown read-only with a short reason.
- **Validation before save**: the patched file is reopened by the same preview
  parser. If it fails, the save is refused and nothing is written.

## Where saving works

T3's `projects.writeFile` takes text only and has no expected-revision check, so
it can't save a binary file safely. The gateway gets one new route:

`PUT /api/workspace-file?thread=<id>&path=<rel>` with the patched bytes and an
`If-Match: <sha256 of the bytes the editor loaded>` header.

- It resolves the path only inside a Bot folder under `$THREEBOT_HOME/bots`
  (or an adopted Bot's project folder) on this machine. It refuses `..`, links that
  leave the folder, and any extension except `.xlsx` and `.docx`.
- If the current file's sha256 doesn't match `If-Match`, it answers 409 and the UI
  says the file changed and offers Reload.
- It writes a temp file, fsyncs, keeps the previous version as
  `<name>.<timestamp>.bak` (the last 3 only), then renames over the original.
- Files of a Bot whose project lives on a linked T3 machine stay preview-only, with
  "Editing works for Bots on this computer" in place of the Edit button.

## Libraries

- Zip: `fflate` (MIT, small, sync and async). Loaded only when an Office file opens.
- XML: the browser's `DOMParser` / `XMLSerializer`, with namespace-aware lookups.
- No full spreadsheet or Word library. A second reader (SheetJS / LibreOffice) is
  used only in tests, to check that saved files open.

## UI

- Sheet view: tabs per sheet, frozen header row/column letters, virtual rows past
  500, cells show the cached value. Double-click or Enter edits an editable cell.
- Document view: rendered paragraphs; click an editable paragraph to edit it in
  place.
- An "Unsaved changes" bar with Save and Discard. Closing with unsaved changes
  asks first. "Open original file" stays.

## Acceptance

Deterministic tests (`npm run check`):

- **Round trip**: for fixtures with formulas, styles, comments, merged cells, an
  image, tracked changes and a table, edit one cell or paragraph and save. Every
  other zip entry is byte-identical, and the edited node holds the new value.
- **Read-only cases**: formula cells, rich text, fields and tracked-change
  paragraphs refuse editing.
- **Save route**: an outside path, `..`, a symlink escape or another extension is
  refused. A stale `If-Match` returns 409. A failed write leaves the original
  intact. The backup count is capped at 3.

Live, recorded in this doc:

- A Bot-made `.xlsx` and `.docx` open in the PWA, the Mac app and iPhone Safari.
- Edit, save, and reopen in Numbers/Excel and Pages/Word show the change and
  intact formatting.

## Open questions

1. Should a saved edit tell the Bot? Draft: no message; the Bot sees the new file
   the next time it reads it.
2. Is `.bak` next to the file right, or should backups live in a hidden folder?
   Draft: hidden `.threebot-backups/` in the Bot folder.
