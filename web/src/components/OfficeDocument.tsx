import { useEffect, useState, type ReactNode } from "react";
import type { DocBlock, DocParagraph, DocRun, DocumentData, Workbook } from "../lib/office";

type Parsed = { kind: "sheet"; workbook: Workbook } | { kind: "doc"; document: DocumentData } | { kind: "refused"; message: string };

/** Read-only .xlsx and .docx preview. A file the parser refuses explains why; the sheet keeps its original-file link. */
export default function OfficeDocument({ data, kind, onError }: { data: ArrayBuffer; kind: "sheet" | "doc"; onError: (error: unknown) => void }) {
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
  return parsed.kind === "sheet" ? <SheetView workbook={parsed.workbook} /> : <DocumentView document={parsed.document} />;
}

function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function SheetView({ workbook }: { workbook: Workbook }) {
  const [index, setIndex] = useState(0);
  const sheet = workbook.sheets[index];
  if (!sheet) return <p className="p-6 text-center text-[14px] text-muted">This workbook has no sheets to show.</p>;
  const columns = Array.from({ length: sheet.columns }, (_, column) => columnName(column));
  const note = [sheet.truncatedRows && "the first 1,000 rows", sheet.truncatedColumns && "the first 100 columns"].filter(Boolean).join(" and ");
  return <div className="office-sheet">
    <div role="tablist" aria-label="Sheets" className="office-sheet-tabs scroll-thin">
      {workbook.sheets.map((item, i) => <button key={i} type="button" role="tab" aria-selected={i === index} onClick={() => setIndex(i)}>{item.name}</button>)}
    </div>
    <div className="office-grid scroll-thin">
      {sheet.rows.length ? <table aria-label={sheet.name}>
        <thead><tr><th aria-hidden="true" />{columns.map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, r) => <tr key={r}><th scope="row">{r + 1}</th>{columns.map((name, c) => <td key={name}>{row[c] ?? ""}</td>)}</tr>)}</tbody>
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
  return <article className="office-doc md mx-auto max-w-[760px] px-6 py-6 text-[14.5px] leading-[1.6]"><Blocks blocks={document.blocks} images={images} /></article>;
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
