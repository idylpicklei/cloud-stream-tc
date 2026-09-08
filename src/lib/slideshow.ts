/**
 * Load a multi-slide deck from PDF and/or image files for PiP presentation.
 */

import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let workerConfigured = false;

function ensurePdfWorker(): void {
  if (workerConfigured) return;
  GlobalWorkerOptions.workerSrc = pdfWorker;
  workerConfigured = true;
}

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

export class SlideshowDeck {
  private slides: HTMLCanvasElement[] = [];
  private index = 0;
  private label = "";

  get length(): number {
    return this.slides.length;
  }

  get currentIndex(): number {
    return this.index;
  }

  get name(): string {
    return this.label;
  }

  current(): HTMLCanvasElement | null {
    return this.slides[this.index] ?? null;
  }

  next(): HTMLCanvasElement | null {
    if (this.slides.length === 0) return null;
    this.index = Math.min(this.slides.length - 1, this.index + 1);
    return this.current();
  }

  prev(): HTMLCanvasElement | null {
    if (this.slides.length === 0) return null;
    this.index = Math.max(0, this.index - 1);
    return this.current();
  }

  goTo(i: number): HTMLCanvasElement | null {
    if (this.slides.length === 0) return null;
    this.index = Math.min(this.slides.length - 1, Math.max(0, i));
    return this.current();
  }

  dispose(): void {
    this.slides = [];
    this.index = 0;
    this.label = "";
  }

  static async fromFiles(files: FileList | File[]): Promise<SlideshowDeck> {
    const list = [...files];
    if (list.length === 0) {
      throw new Error("Choose a PDF or one or more images to build a slideshow.");
    }

    const deck = new SlideshowDeck();
    const labels: string[] = [];

    for (const file of list) {
      labels.push(file.name);
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        const pages = await renderPdfToCanvases(file);
        deck.slides.push(...pages);
      } else if (IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) {
        deck.slides.push(await renderImageToCanvas(file));
      } else {
        throw new Error(
          `Unsupported file “${file.name}”. Use PDF, PNG, JPEG, WebP, GIF, or BMP.`,
        );
      }
    }

    if (deck.slides.length === 0) {
      throw new Error("No slides could be loaded from those files.");
    }

    deck.label =
      list.length === 1
        ? list[0].name
        : `${list.length} files · ${deck.slides.length} slides`;
    deck.index = 0;
    return deck;
  }
}

async function renderImageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not create canvas for slide image");
    ctx.drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

async function renderPdfToCanvases(file: File): Promise<HTMLCanvasElement[]> {
  ensurePdfWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf: PDFDocumentProxy = await getDocument({ data }).promise;
  const pages: HTMLCanvasElement[] = [];

  try {
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      // Target ~1280px wide slides for crisp PiP / full-stage readability.
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.min(2.2, 1280 / unscaled.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not create canvas for PDF page");
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push(canvas);
    }
  } finally {
    await pdf.cleanup();
  }

  return pages;
}
