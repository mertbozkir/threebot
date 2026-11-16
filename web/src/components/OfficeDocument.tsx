import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { DocBlock, DocParagraph, DocRun, DocumentData, Workbook } from "../lib/office";

type Parsed = { kind: "sheet"; workbook: Workbook } | { kind: "doc"; document: DocumentData } | { kind: "refused"; message: string };

function rangeTsv(rows: string[][], top: number, bottom: number, left: number, right: number): string {
  const lines: string[] = [];
  for (let r = top; r <= bottom; r++) {
    const cells: string[] = [];
    for (let c = left; c <= right; c++) cells.push(rows[r]?.[c] ?? "");
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/** Read-only .xlsx and .docx preview. A file the parser refuses explains why; the sheet keeps its original-file link. */
export default function OfficeDocument({ data, kind, onError, onRows }: { data: ArrayBuffer; kind: "sheet" | "doc"; onError: (error: unknown) => void; onRows?: (count: number, truncated: boolean) => void }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  useEffect(() => {
    let live = true;
    setParsed(null);
    // The parser and fflate load only when an Office file is opened.
    import("../lib/office").then(async ({ parseXlsx, parseDocx, OfficeFileError }) => {
      try {
        const next: Parsed = kind === "sheet" ? { kind, workbook: await parseXlsx(data) } : { kind, document: await parseDocx(data) };
        if (live) setParsed(next);
      } catch (error) {
        if (!live) return;
        if (error instanceof OfficeFileError) setParsed({ kind: "refused", message: error.message }); else onError(error);
      }
    }).catch((error: unknown) => { if (live) onError(error); });
    return () => { live = false; };
  }, [data, kind]);
  if (!parsed) return <p role="status" className="p-6 text-center text-[14px] text-muted">Loading file…</p>;
  if (parsed.kind === "refused") return <p role="alert" className="p-6 text-center text-[14px] text-muted">{parsed.message}</p>;
  return parsed.kind === "sheet" ? <SheetView workbook={parsed.workbook} onRows={onRows} /> : <DocumentView document={parsed.document} />;
}

function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

type Cell = [row: number, column: number];
type Selection = { anchor: Cell; focus: Cell };

const HINT_COLLAPSED_KEY = "office-sheet-hint-collapsed";

function readHintCollapsed() {
  try { return localStorage.getItem(HINT_COLLAPSED_KEY) === "1"; } catch { return false; }
}

function storeHintCollapsed(collapsed: boolean) {
  try { localStorage.setItem(HINT_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* storage may be unavailable */ }
}

function copyKeyLabel() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘C" : "Ctrl+C";
}

const ARROW_MOVES: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

function SheetView({ workbook, onRows }: { workbook: Workbook; onRows?: (count: number, truncated: boolean) => void }) {
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hintCollapsed, setHintCollapsed] = useState(readHintCollapsed);
  const sheet = workbook.sheets[index];
  useEffect(() => { onRows?.(sheet?.rows.length ?? 0, !!sheet?.truncatedRows); }, [sheet, onRows]);
  if (!sheet) return <p className="p-6 text-center text-[14px] text-muted">This workbook has no sheets to show.</p>;
  const columns = Array.from({ length: sheet.columns }, (_, column) => columnName(column));
  const note = [sheet.truncatedRows && "the first 1,000 rows", sheet.truncatedColumns && "the first 100 columns"].filter(Boolean).join(" and ");
  const inSelection = (row: number, column: number) => {
    if (!selection) return false;
    const top = Math.min(selection.anchor[0], selection.focus[0]);
    const bottom = Math.max(selection.anchor[0], selection.focus[0]);
    const left = Math.min(selection.anchor[1], selection.focus[1]);
    const right = Math.max(selection.anchor[1], selection.focus[1]);
    return row >= top && row <= bottom && column >= left && column <= right;
  };
  const select = (row: number, column: number, extend: boolean) => setSelection((current) => ({
    anchor: current && extend ? current.anchor : [row, column],
    focus: [row, column],
  }));
  const move = (rowDelta: number, columnDelta: number, extend: boolean) => setSelection((current) => {
    const base = current?.focus ?? [0, 0];
    const focus: Cell = [
      Math.min(Math.max(base[0] + rowDelta, 0), Math.max(sheet.rows.length - 1, 0)),
      Math.min(Math.max(base[1] + columnDelta, 0), Math.max(sheet.columns - 1, 0)),
    ];
    return { anchor: current && extend ? current.anchor : focus, focus };
  });
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      if (selection) { event.stopPropagation(); setSelection(null); }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      if (!selection || !sheet.rows.length || !sheet.columns) return;
      event.preventDefault();
      const top = Math.min(selection.anchor[0], selection.focus[0]);
      const bottom = Math.max(selection.anchor[0], selection.focus[0]);
      const left = Math.min(selection.anchor[1], selection.focus[1]);
      const right = Math.max(selection.anchor[1], selection.focus[1]);
      void navigator.clipboard?.writeText(rangeTsv(sheet.rows, top, bottom, left, right));
      return;
    }
    const delta = event.metaKey || event.ctrlKey || event.altKey ? undefined : ARROW_MOVES[event.key];
    if (!delta) return;
    event.preventDefault();
    move(delta[0], delta[1], event.shiftKey);
  };
  return <div className="office-sheet">
    <div className="office-hint">
      {!hintCollapsed && <span className="min-w-0">Click a cell to select it. Move with the arrow keys, extend with Shift, copy with {copyKeyLabel()}.</span>}
      <button type="button" aria-expanded={!hintCollapsed} aria-label={hintCollapsed ? "Show selection help" : "Hide selection help"}
        onClick={() => { setHintCollapsed(!hintCollapsed); storeHintCollapsed(!hintCollapsed); }}>
        {hintCollapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>
    </div>
    <div role="tablist" aria-label="Sheets" className="office-sheet-tabs scroll-thin">
      {workbook.sheets.map((item, i) => <button key={i} type="button" role="tab" aria-selected={i === index} onClick={() => { setIndex(i); setSelection(null); }}>{item.name}</button>)}
    </div>
    <div className="office-grid scroll-thin">
      {sheet.rows.length ? <table role="grid" tabIndex={0} aria-label={sheet.name} onKeyDown={onKeyDown}>
        <thead><tr><th aria-hidden="true" />{columns.map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, r) => <tr key={r}><th scope="row">{r + 1}</th>{columns.map((name, c) => <td key={name} role="gridcell" aria-selected={inSelection(r, c)} onClick={(event) => select(r, c, event.shiftKey)}>{row[c] ?? ""}</td>)}</tr>)}</tbody>
      </table> : !note && <p className="p-6 text-center text-[14px] text-muted">This sheet is empty.</p>}
    </div>
    {note && <p role="status" className="office-note">Showing {note}. Open the original file for the rest.</p>}
  </div>;
}

function DocumentView({ document }: { document: DocumentData }) {
  const [images, setImages] = useState<string[]>([]);
  useEffect(() => {
    const urls = document.images.map((image) => URL.createObjectURL(new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type })));
    setImages(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [document]);
  return <article className="office-doc md mx-auto max-w-[820px] px-6 py-8 text-[15px] leading-[1.65]"><Blocks blocks={document.blocks} images={images} /></article>;
}

function Blocks({ blocks, images }: { blocks: DocBlock[]; images: string[] }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "table") {
      out.push(<table key={i}><tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} colSpan={cell.colSpan > 1 ? cell.colSpan : undefined} rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}><Blocks blocks={cell.blocks} images={images} /></td>)}</tr>)}</tbody></table>);
    } else if (block.list) {
      const items: DocParagraph[] = [];
      for (let next = blocks[i]; next?.type === "paragraph" && next.list?.ordered === block.list.ordered; next = blocks[++i]) items.push(next);
      i--;
      const List = block.list.ordered ? "ol" : "ul";
      out.push(<List key={i}>{items.map((item, j) => <li key={j} dir={item.rtl ? "rtl" : "auto"} style={item.list?.level ? { marginInlineStart: `${item.list.level * 1.5}em` } : undefined}><Runs runs={item.runs} images={images} /></li>)}</List>);
    } else {
      const Tag = block.heading ? (`h${block.heading}` as "h1") : "p";
      out.push(<Tag key={i} dir={block.rtl ? "rtl" : "auto"}><Runs runs={block.runs} images={images} /></Tag>);
    }
  }
  return <>{out}</>;
}

function Runs({ runs, images }: { runs: DocRun[]; images: string[] }) {
  return <>{runs.map((run, i) => {
    if ("image" in run) return images[run.image] ? <img key={i} src={images[run.image]} alt={run.alt} style={run.width ? { width: run.width } : undefined} /> : null;
    const text = run.italic ? <em>{run.text}</em> : run.text;
    return <span key={i} dir={run.rtl ? "rtl" : undefined}>{run.bold ? <strong>{text}</strong> : text}</span>;
  })}</>;
}
