import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/**
 * Draws a PDF onto canvases with pdf.js. Browser PDF plugins can't be relied on here:
 * WebKit (Safari, the Mac app) draws nothing for a PDF inside a frame.
 * The legacy build is deliberate: the modern one never finishes rendering in Safari 18 (measured).
 */
export default function PdfDocument({ data, title, onError }: { data: ArrayBuffer; title: string; onError: (error: unknown) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let live = true;
    let destroy = () => {};
    // pdf.js is large; load it only when a PDF is opened.
    import("pdfjs-dist/legacy/build/pdf.mjs").then(({ getDocument, GlobalWorkerOptions }) => {
      if (!live) return;
      GlobalWorkerOptions.workerSrc = workerUrl;
      // pdf.js takes ownership of the buffer it's given; keep the caller's copy usable for retries.
      const task = getDocument({ data: new Uint8Array(data.slice(0)), enableXfa: false });
      // Destroying the loading task also frees the document and its worker.
      destroy = () => { void task.destroy(); };
      return task.promise.then((doc) => { if (live) setPdf(doc); });
    }).catch((error: unknown) => { if (live) onError(error); });
    return () => { live = false; destroy(); };
  }, [data]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new window.ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!pdf || !element || width < 50) return;
    let live = true;
    const tasks: { cancel: () => void }[] = [];
    element.replaceChildren();
    (async () => {
      for (let number = 1; number <= pdf.numPages && live; number++) {
        const page = await pdf.getPage(number);
        if (!live) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(width - 32, 1200) / base.width });
        const ratio = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.className = "mx-auto mb-4 block bg-white shadow-[var(--shadow-pop)]";
        canvas.setAttribute("aria-label", `${title}, page ${number} of ${pdf.numPages}`);
        canvas.setAttribute("role", "img");
        element.append(canvas);
        const task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        tasks.push(task);
        await task.promise.catch((error: unknown) => { if (live && (error as { name?: string })?.name !== "RenderingCancelledException") throw error; });
      }
    })().catch((error: unknown) => { if (live) onError(error); });
    return () => { live = false; tasks.forEach((task) => task.cancel()); };
  }, [pdf, width, title]);

  return <div ref={host} className="pdf-document min-h-full bg-hover px-4 py-4" data-pages={pdf?.numPages ?? undefined} />;
}
