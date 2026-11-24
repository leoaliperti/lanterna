import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist";

/**
 * Visualizzatore PDF (pdf.js, Apache-2.0). Il worker è un file della stessa origine (CSP `worker-src 'self'`),
 * servito dal bundle di Vite: nessun CDN. Il PDF lo scarica il browser con il cookie di sessione.
 */
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;

/** Apre il PDF. Il task serve anche a chiuderlo (`task.destroy()`), quando il visualizzatore si smonta. */
export function openPdf(url: string): PDFDocumentLoadingTask {
  return getDocument({ url, withCredentials: true });
}

/** Disegna una pagina su un canvas largo `width` pixel. Restituisce il canvas e il rapporto altezza/larghezza. */
export async function renderPage(doc: PDFDocumentProxy, pageIndex: number, width: number): Promise<{ canvas: HTMLCanvasElement; ratio: number }> {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = width / base.width;
  const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${(base.height / base.width) * width}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas non disponibile");
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return { canvas, ratio: base.height / base.width };
}
