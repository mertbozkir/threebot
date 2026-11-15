# Office files: preview and basic editing

Status: Draft v2, revised after three zero-context reviews
Date: 2026-11-15

## Goal

Bots write `.xlsx` and `.docx` files into their workspace. Today the viewer
classifies them as `file` and shows "Preview isn't available". This adds:

1. **PR 1, preview**: read-only sheets (a tab per sheet, a cell grid) and Word
   documents (headings, paragraphs, lists, tables, images). There is no gateway
   change.
2. **PR 2, basic editing**: change a cell value or the text of a simple
   paragraph, then save back to the same file.

Edits never rebuild the file. Content the editor doesn't understand stays as it was.

## Non-goals

- A full Office suite: no formatting, no inserting rows, cells, tables or
  images, no formula editing, no charts.
- `.xls`, `.doc`, `.xlsm`, `.pptx`, `.odt`, and password-protected files. These get
  the original-file link only.
- Editing files outside a Bot's `library/` folder, or on a linked machine.
- Merging concurrent edits. A conflict is reported, not merged.

## PR 1: preview

- `workspaceFileKind` (web/src/lib/workspaceLinks.ts) gains `sheet` (`.xlsx`) and
  `doc` (`.docx`).
  - ChatAttachments and Library get these kinds through the same function.
  - `workspaceAssets.ts` keeps sending them through the `media-file` route.
- `ResourceSheet` (WorkspaceResource.tsx) reads them with `arrayBuffer()`, the
  same way it reads PDFs. It lazy-loads a new `OfficeDocument.tsx`, the way
  `PdfDocument.tsx` is loaded.
- Parsing uses `fflate`'s async `unzip`, then `DOMParser`.
  - Before inflating, the parser checks entry sizes from the central directory:
    at most 2,000 entries, 100 MB uncompressed in total, and 30 MB per part. It
    refuses a duplicate or `\`-separated entry name.
  - It also refuses a file that isn't a zip with `[Content_Types].xml` and its
    main part, such as an encrypted OLE file.
  - Parts are found through `workbook.xml` and its rels (sheet name to part), or
    `document.xml`, by namespace-aware local names, so it works with or without
    an `x:`/`w:` prefix.
- **Sheets**:
  - Show the first 1,000 rows. Past that, a note says "Showing the first 1,000
    rows" and points to the original file.
  - Cells show their cached value.
  - Numbers with a date number format are shown as dates (1900 and 1904 systems).
- **Documents**:
  - Paragraphs get their heading style, and lists, tables and images are drawn.
  - The text direction comes from `w:bidi`/`w:rtl`.
  - Fields show their cached result.
- "Open original file" stays on both views.

## PR 2: editing

### What is editable

- **XLSX**:
  - Editable: an existing `<c>` with no `<f>` child (this also rules out shared
    and array formula children). Its type must be a plain number (no `t`, or
    `t="n"`, without a date format), a non-rich shared string (`t="s"`), or an
    inline string (`t="inlineStr"`).
  - Read-only: `t="b"`, `"e"`, `"str"`, `"d"`, date-formatted numbers, rich text,
    and empty positions that have no `<c>` element.
- **XLSX type rules**:
  - A number cell accepts only a number; anything else is refused.
  - A string cell stays a string, even if the user types "12" or "TRUE", so IDs
    with leading zeros survive.
- **DOCX**:
  - Editable: a paragraph with exactly one `<w:r>` holding exactly one `<w:t>`.
    Its other children may only be `w:pPr`, `w:proofErr`, `w:bookmarkStart` or
    `w:bookmarkEnd`.
  - Read-only: anything else, with one generic reason ("This paragraph has
    formatting the editor can't keep").
  - Typed newlines are refused, and the text isn't Unicode-normalized.

### How a save changes the file

- **Text splice, not re-serialization.** The editor finds the byte range of the
  one `<c>…</c>` or `<w:t>…</w:t>` with a small tokenizer and replaces only that
  range. The XML declaration, namespace declarations, `mc:Ignorable` and
  everything else in the part stay exactly as written.
- **XLSX cell rewrite.**
  - The cell keeps `r` and `s`, and loses `t`, `<v>` and `<is>`.
  - A string becomes `t="inlineStr"` with `<is><t xml:space="preserve">…</t></is>`.
  - A number becomes `<v>…</v>`.
  - The shared string table is untouched, so other cells keep their strings.
- **Recalculation.**
  - If the workbook has any `<f>`, `workbook.xml`'s `<calcPr>` gets
    `fullCalcOnLoad="1"`. The tag is created in schema order if missing, with
    other attributes kept.
  - The UI then notes that formulas update when the file next opens in Excel,
    and Numbers may not recalculate.
  - A workbook with no formulas is not touched outside the edited sheet.
- **DOCX text rewrite.** The new text is XML-escaped. `xml:space="preserve"` is
  set when the text has leading, trailing or double spaces.
- **Zip.**
  - The output keeps the original entry order and names.
  - Entries that were stored stay stored.
  - Every entry except the edited part (and `workbook.xml` when `calcPr` changes)
    has identical decompressed bytes. Compressed bytes may differ.
- **Before upload.** The client re-parses the result. If parsing fails or
  `DOMParser` returns a `parsererror`, the save stops.

### Save route

`PUT /api/workspace-file?thread=<id>&path=<library-relative path>` with the raw
bytes.

- **Auth and origin.** The existing `authed()` and `sameOriginRequest` checks for
  `/api/` writes apply. The `Content-Type` must be
  `application/vnd.openxmlformats-officedocument.*`. It sends no CORS headers.
- **`If-Match` is required.** A missing one gets 428; a stale one gets 409. The
  client computes the sha256 from the bytes it loaded through the asset URL, and
  the server compares it with the current file.
- **Size.** It reads a raw body with a 25 MB cap, enforced while streaming, and
  answers 413 above it.
- **Thread to folder.**
  - `shellThreads` gives the thread's `projectId`, which must match a Bot from
    `listBots()`. The root is `realpath(bot.workspaceRoot + "/library")`.
  - It rejects threads with a `worktreePath`, `environment:` ids, and non-local
    environments, with 403. The UI shows Edit only when the asset loaded from
    this machine, and the server checks independently.
- **Path.**
  - It rejects NUL bytes, absolute paths and `..`.
  - The target must already exist, be a regular file with `nlink == 1`, and its
    lower-cased extension must be `.xlsx` or `.docx`.
  - It takes `realpath` of the target and requires it inside the root (prefix
    plus separator).
  - All checks use the real path, not the request string.
- **Write.**
  - Under `withFileLock(realpath)`, it re-checks the hash.
  - It writes a uniquely named temp file (`O_EXCL`) in the same folder with the
    original mode, fsyncs, re-checks the hash, renames, and fsyncs the folder.
  - Before the rename, the server checks the zip structure itself, the same way
    the parser does.
  - The check-then-rename window against an outside writer (a Bot saving the same
    file) is narrowed by the second check but not closed. That is a known limit.
- **No backups.** The atomic rename prevents torn files, and the patch touches one
  node.

## Libraries and size

- `fflate` (MIT, ~30 KB) is the only new web dependency. It loads with the Office
  viewer chunk, which the PWA precaches; the cost is small.
- Tests use only the repo's own code; there's no second spreadsheet library.

## Acceptance

Deterministic (`npm run check`):

- **Parser:** sheets, a 1904-dated workbook, date formats, the 1,000-row cap, RTL
  and Turkish paragraphs, refusal of zip bombs, duplicate names and OLE files.
- **Round trip,** with a generated fixture that has formulas (including a shared
  formula), styles, comments, merged cells, an image and tracked changes:
  - Edit one cell and one paragraph.
  - The edited part differs only inside the edited node.
  - All other entries (apart from `workbook.xml` `calcPr`) have identical
    decompressed bytes, in the same order.
- **Refusals:** formula cells, shared-formula children, bool/error/date cells,
  missing cells, rich text, multi-run paragraphs and fields are read-only.
- **Save route** (`server/workspace-file.test.mts`, temp bots root): it refuses
  outside paths, `..`, symlink escapes, hard links, new files, other extensions,
  a missing `If-Match` (428), a stale one (409), a too-big body (413), a broken
  zip, and a worktree or remote thread. A failed write leaves the original intact.
- **Fixture:** the `library` scenario gets a small xlsx and docx that open in the
  viewer.

Live, recorded in this doc: open a Bot-made `.xlsx` and `.docx` in the PWA and the
Mac app; edit, save, and reopen in Numbers or Excel and Pages or Word.

## Known limits

- A Bot writing the same file at the same moment can still win the race; the
  editor reports a 409 on its next save.
- The Bot isn't told about a user's edit; it sees the new file next time it reads it.
- Sheets past 1,000 rows are partly shown; editing applies to shown rows only.
- Tapping a cell selects it, and tapping again edits it, on phones too.
