/**
 * Compose a main video with an optional picture-in-picture layer onto a canvas,
 * then expose the result as a MediaStreamTrack for WHIP publish.
 */

export type PipCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type PipSize = "small" | "medium" | "large";

const SIZE_FRACTION: Record<PipSize, number> = {
  small: 0.22,
  medium: 0.3,
  large: 0.38,
};

const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const PIP_MARGIN = 24;
const PIP_RADIUS = 12;

export class VideoCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mainVideo: HTMLVideoElement;
  private readonly pipVideo: HTMLVideoElement;
  private pipStill: CanvasImageSource | null = null;
  private pipMode: "none" | "video" | "still" = "none";
  private corner: PipCorner = "bottom-right";
  private pipSize: PipSize = "medium";
  private mainEnabled = true;
  /** When true, the PiP source fills the stage and the main camera sits in the PiP box. */
  private swapped = false;
  private raf: number | null = null;
  private outputStream: MediaStream | null = null;
  private running = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = OUTPUT_WIDTH;
    this.canvas.height = OUTPUT_HEIGHT;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Could not create 2D canvas context for video compositor");
    this.ctx = ctx;

    this.mainVideo = document.createElement("video");
    this.mainVideo.muted = true;
    this.mainVideo.playsInline = true;
    this.mainVideo.autoplay = true;

    this.pipVideo = document.createElement("video");
    this.pipVideo.muted = true;
    this.pipVideo.playsInline = true;
    this.pipVideo.autoplay = true;
  }

  getPreviewElement(): HTMLCanvasElement {
    return this.canvas;
  }

  async setMainStream(stream: MediaStream | null): Promise<void> {
    this.mainVideo.srcObject = stream;
    if (stream) {
      await this.mainVideo.play().catch(() => undefined);
    }
  }

  /**
   * Hide/show the main camera without touching its stream. While hidden, an
   * active PiP source fills the stage; with no PiP, a "Camera off" card is drawn.
   */
  setMainEnabled(enabled: boolean): void {
    this.mainEnabled = enabled;
  }

  get isMainEnabled(): boolean {
    return this.mainEnabled;
  }

  get hasPip(): boolean {
    return this.pipMode !== "none";
  }

  /** Flip which feed fills the stage: camera (default) or the PiP source. */
  setSwapped(swapped: boolean): void {
    this.swapped = swapped;
  }

  get isSwapped(): boolean {
    return this.swapped;
  }

  async setPipVideoStream(stream: MediaStream | null): Promise<void> {
    this.pipStill = null;
    this.pipVideo.srcObject = stream;
    if (stream) {
      this.pipMode = "video";
      await this.pipVideo.play().catch(() => undefined);
    } else if (this.pipMode === "video") {
      this.pipMode = "none";
    }
  }

  setPipStill(source: CanvasImageSource | null): void {
    this.pipStill = source;
    if (source) {
      this.pipMode = "still";
      this.pipVideo.srcObject = null;
    } else if (this.pipMode === "still") {
      this.pipMode = "none";
    }
  }

  clearPip(): void {
    this.pipMode = "none";
    this.pipStill = null;
    this.pipVideo.srcObject = null;
  }

  setCorner(corner: PipCorner): void {
    this.corner = corner;
  }

  setPipSize(size: PipSize): void {
    this.pipSize = size;
  }

  /** Start the draw loop and return a MediaStream suitable for WHIP (video only). */
  start(fps = 30): MediaStream {
    if (!this.outputStream) {
      this.outputStream = this.canvas.captureStream(fps);
    }
    if (!this.running) {
      this.running = true;
      this.tick();
    }
    return this.outputStream;
  }

  getOutputStream(): MediaStream | null {
    return this.outputStream;
  }

  getOutputVideoTrack(): MediaStreamTrack | null {
    return this.outputStream?.getVideoTracks()[0] ?? null;
  }

  stop(): void {
    this.running = false;
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  dispose(): void {
    this.stop();
    this.outputStream?.getTracks().forEach((t) => t.stop());
    this.outputStream = null;
    this.mainVideo.srcObject = null;
    this.pipVideo.srcObject = null;
    this.pipStill = null;
  }

  private tick = (): void => {
    if (!this.running) return;
    this.drawFrame();
    this.raf = requestAnimationFrame(this.tick);
  };

  private drawFrame(): void {
    const { ctx, canvas } = this;
    ctx.fillStyle = "#07131c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const mainPresent = this.mainEnabled && this.mainVideo.srcObject != null;
    const pipSource =
      this.pipMode === "none"
        ? null
        : this.pipMode === "still"
          ? this.pipStill
          : this.pipVideo.readyState >= 2
            ? this.pipVideo
            : null;

    if (!mainPresent) {
      if (pipSource) {
        // Camera off but a visual feed is on: promote it to the full stage.
        drawContain(ctx, pipSource, 0, 0, canvas.width, canvas.height);
      } else {
        drawOfflineCard(ctx, canvas.width, canvas.height);
      }
      return;
    }

    const mainReady = this.mainVideo.readyState >= 2;

    if (pipSource && this.swapped) {
      // Swapped layout: slides / second feed on the stage, camera in the corner.
      drawContain(ctx, pipSource, 0, 0, canvas.width, canvas.height);
      if (!mainReady) return;
      this.drawPipBox(this.mainVideo, drawCover);
      return;
    }

    if (mainReady) {
      drawCover(ctx, this.mainVideo, 0, 0, canvas.width, canvas.height);
    }

    if (!pipSource) return;
    this.drawPipBox(pipSource, drawContain);
  }

  private drawPipBox(
    source: CanvasImageSource,
    draw: (
      ctx: CanvasRenderingContext2D,
      source: CanvasImageSource,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => void,
  ): void {
    const { ctx, canvas } = this;
    const box = pipRect(canvas.width, canvas.height, this.corner, this.pipSize);
    ctx.save();
    roundRectPath(ctx, box.x - 3, box.y - 3, box.w + 6, box.h + 6, PIP_RADIUS + 2);
    ctx.fillStyle = "rgba(7, 19, 28, 0.85)";
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, box.x, box.y, box.w, box.h, PIP_RADIUS);
    ctx.clip();
    draw(ctx, source, box.x, box.y, box.w, box.h);
    ctx.restore();

    ctx.save();
    roundRectPath(ctx, box.x, box.y, box.w, box.h, PIP_RADIUS);
    ctx.strokeStyle = "rgba(224, 247, 255, 0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function drawOfflineCard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, "#0b1f2b");
  gradient.addColorStop(1, "#07131c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(224, 247, 255, 0.9)";
  ctx.font = "600 44px Sora, 'Segoe UI', sans-serif";
  ctx.fillText("Camera off", w / 2, h / 2 - 18);
  ctx.fillStyle = "rgba(224, 247, 255, 0.55)";
  ctx.font = "500 24px 'Source Sans 3', 'Segoe UI', sans-serif";
  ctx.fillText("Training Center — audio continues", w / 2, h / 2 + 30);
  ctx.restore();
}

function sourceSize(source: CanvasImageSource): { w: number; h: number } {
  if (source instanceof HTMLVideoElement) {
    return { w: source.videoWidth || 1, h: source.videoHeight || 1 };
  }
  if (source instanceof HTMLImageElement) {
    return { w: source.naturalWidth || 1, h: source.naturalHeight || 1 };
  }
  if (source instanceof HTMLCanvasElement) {
    return { w: source.width || 1, h: source.height || 1 };
  }
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    return { w: source.width || 1, h: source.height || 1 };
  }
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas) {
    return { w: source.width || 1, h: source.height || 1 };
  }
  return { w: 1, h: 1 };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const { w, h } = sourceSize(source);
  const scale = Math.max(dw / w, dh / h);
  const sw = dw / scale;
  const sh = dh / scale;
  const sx = (w - sw) / 2;
  const sy = (h - sh) / 2;
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const { w, h } = sourceSize(source);
  const scale = Math.min(dw / w, dh / h);
  const tw = w * scale;
  const th = h * scale;
  const tx = dx + (dw - tw) / 2;
  const ty = dy + (dh - th) / 2;
  ctx.fillStyle = "#0b1b24";
  ctx.fillRect(dx, dy, dw, dh);
  ctx.drawImage(source, tx, ty, tw, th);
}

function pipRect(
  canvasW: number,
  canvasH: number,
  corner: PipCorner,
  size: PipSize,
): { x: number; y: number; w: number; h: number } {
  const w = Math.round(canvasW * SIZE_FRACTION[size]);
  const h = Math.round((w * 9) / 16);
  const m = PIP_MARGIN;
  switch (corner) {
    case "top-left":
      return { x: m, y: m, w, h };
    case "top-right":
      return { x: canvasW - w - m, y: m, w, h };
    case "bottom-left":
      return { x: m, y: canvasH - h - m, w, h };
    case "bottom-right":
    default:
      return { x: canvasW - w - m, y: canvasH - h - m, w, h };
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
