/**
 * Student talk-back over the ClassRoom WebSocket relay.
 *
 * - RoomConnection: resilient WebSocket to `/api/room/ws` (auto-reconnect, keepalive).
 * - TalkbackSender: viewer-side mic capture → 16 kHz Int16 PCM frames while PTT is held.
 * - TalkbackReceiver: host-side playback of relayed PCM into a Web Audio graph.
 *
 * Why not WebRTC? Cloudflare Stream live inputs are strictly one-way, and a
 * browser-to-browser WebRTC leg would need TURN to be reliable. PCM over a
 * WebSocket to the edge always connects and is plenty for short questions.
 */

import {
  HOST_FRAME_HEADER_BYTES,
  ROOM_WS_PATH,
  TALKBACK_SAMPLE_RATE,
  VIEWER_FRAME_HEADER_BYTES,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/roomProtocol";
import { rmsFromTimeDomain } from "./audioMixer";

export type RoomStatus = "connecting" | "open" | "closed";

interface RoomConnectionOptions {
  hello: () => ClientMessage;
  onMessage: (message: ServerMessage) => void;
  onBinary?: (frame: ArrayBuffer) => void;
  onStatus?: (status: RoomStatus) => void;
}

const KEEPALIVE_MS = 25_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 12_000;

export class RoomConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private keepaliveTimer: number | null = null;
  private readonly options: RoomConnectionOptions;

  constructor(options: RoomConnectionOptions) {
    this.options = options;
    this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message: ClientMessage): void {
    if (!this.isOpen) return;
    try {
      this.ws?.send(JSON.stringify(message));
    } catch {
      // Socket is going away; reconnect logic will handle it.
    }
  }

  sendBinary(frame: ArrayBuffer | ArrayBufferView): void {
    if (!this.isOpen) return;
    try {
      this.ws?.send(frame);
    } catch {
      // Ignore; frames are best-effort.
    }
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.ws?.close(1000, "client closed");
    this.ws = null;
  }

  private connect(): void {
    if (this.closed) return;
    this.options.onStatus?.("connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}${ROOM_WS_PATH}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.send(this.options.hello());
      this.options.onStatus?.("open");
      this.keepaliveTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, KEEPALIVE_MS);
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === "string") {
        if (event.data === "pong") return;
        try {
          this.options.onMessage(JSON.parse(event.data) as ServerMessage);
        } catch {
          // Ignore malformed frames.
        }
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.options.onBinary?.(event.data);
      }
    });

    const onGone = () => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.ws = null;
      this.options.onStatus?.("closed");
      this.scheduleReconnect();
    };
    ws.addEventListener("close", onGone);
    ws.addEventListener("error", onGone);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer != null) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.keepaliveTimer != null) {
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Viewer capture                                                            */
/* ------------------------------------------------------------------------ */

const CHUNK_MS = 100;

/**
 * AudioWorklet source. Resamples the mic to TALKBACK_SAMPLE_RATE with linear
 * interpolation and posts Int16 chunks only while `active`. Kept as a string so
 * it ships inside the main bundle without extra asset plumbing.
 */
const CAPTURE_WORKLET_SOURCE = `
class TalkbackCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSamples = opts.chunkSamples || 1600;
    this.ratio = sampleRate / this.targetRate;
    this.pos = 0;
    this.prev = 0;
    this.out = new Int16Array(this.chunkSamples);
    this.outLen = 0;
    this.active = false;
    this.levelBlocks = 0;
    this.levelAcc = 0;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "active") {
        this.active = Boolean(data.active);
        if (!this.active) this.flush();
      }
    };
  }

  flush() {
    if (this.outLen === 0) return;
    const copy = this.out.slice(0, this.outLen);
    this.port.postMessage({ type: "chunk", samples: copy.buffer }, [copy.buffer]);
    this.outLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const len = input[0].length;
    let mono = input[0];
    if (channels > 1) {
      mono = new Float32Array(len);
      for (let c = 0; c < channels; c++) {
        const ch = input[c];
        for (let i = 0; i < len; i++) mono[i] += ch[i] / channels;
      }
    }

    let sum = 0;
    for (let i = 0; i < len; i++) sum += mono[i] * mono[i];
    this.levelAcc += Math.sqrt(sum / len);
    this.levelBlocks += 1;
    if (this.levelBlocks >= 6) {
      const rms = this.levelAcc / this.levelBlocks;
      this.port.postMessage({ type: "level", value: Math.min(1, rms * 3) });
      this.levelAcc = 0;
      this.levelBlocks = 0;
    }

    if (!this.active) {
      this.pos = 0;
      this.prev = mono[len - 1];
      return true;
    }

    let pos = this.pos;
    while (pos < len - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.prev : mono[i];
      const b = mono[i + 1];
      const v = a + (b - a) * frac;
      const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
      this.out[this.outLen++] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      if (this.outLen >= this.chunkSamples) this.flush();
      pos += this.ratio;
    }
    this.pos = pos - len;
    this.prev = mono[len - 1];
    return true;
  }
}
registerProcessor("talkback-capture", TalkbackCapture);
`;

let workletUrl: string | null = null;
function captureWorkletUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }),
    );
  }
  return workletUrl;
}

export type MicState = "idle" | "requesting" | "ready" | "denied";

interface TalkbackSenderOptions {
  connection: RoomConnection;
  onLevel?: (level: number) => void;
  onMicState?: (state: MicState) => void;
  onActive?: (active: boolean) => void;
}

export class TalkbackSender {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** What the user wants (button held / toggled on). */
  private desired = false;
  /** What we are actually doing (mic ready + desired). */
  private active = false;
  private micState: MicState = "idle";
  private preparing: Promise<boolean> | null = null;
  private readonly options: TalkbackSenderOptions;

  constructor(options: TalkbackSenderOptions) {
    this.options = options;
  }

  get state(): MicState {
    return this.micState;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Open the mic (permission prompt on first use). Safe to call repeatedly. */
  prepare(): Promise<boolean> {
    if (this.micState === "ready") return Promise.resolve(true);
    if (this.preparing) return this.preparing;
    this.preparing = this.openMic().finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  /**
   * Press/release. If the mic is still being opened when the user lets go, the
   * release wins — we never start transmitting after the button is up.
   */
  async setActive(active: boolean): Promise<void> {
    this.desired = active;
    if (active && this.micState !== "ready") {
      const ok = await this.prepare();
      if (!ok) {
        this.apply();
        return;
      }
    }
    this.apply();
  }

  /** After a reconnect the room forgets our PTT state; tell it again. */
  resync(): void {
    if (this.active) {
      this.options.connection.send({ type: "ptt", active: true });
    }
  }

  dispose(): void {
    this.desired = false;
    this.apply();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.context?.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.setMicState("idle");
  }

  private apply(): void {
    const next = this.desired && this.micState === "ready" && this.node != null;
    if (this.active === next) return;
    this.active = next;
    if (next) void this.context?.resume().catch(() => undefined);
    this.node?.port.postMessage({ type: "active", active: next });
    this.options.connection.send({ type: "ptt", active: next });
    if (!next) this.options.onLevel?.(0);
    this.options.onActive?.(next);
  }

  private setMicState(state: MicState): void {
    this.micState = state;
    this.options.onMicState?.(state);
  }

  private async openMic(): Promise<boolean> {
    this.setMicState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const context = new AudioContext();
      await context.resume().catch(() => undefined);
      if (!context.audioWorklet) {
        throw new Error("This browser does not support AudioWorklet (needed for talk-back).");
      }
      await context.audioWorklet.addModule(captureWorkletUrl());

      const chunkSamples = Math.round((TALKBACK_SAMPLE_RATE * CHUNK_MS) / 1000);
      const node = new AudioWorkletNode(context, "talkback-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { targetRate: TALKBACK_SAMPLE_RATE, chunkSamples },
      });
      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as
          | { type: "chunk"; samples: ArrayBuffer }
          | { type: "level"; value: number };
        if (data.type === "level") {
          this.options.onLevel?.(this.active ? data.value : 0);
          return;
        }
        if (data.type === "chunk" && this.active) {
          this.options.connection.sendBinary(frameForRoom(data.samples));
        }
      };

      const source = context.createMediaStreamSource(stream);
      source.connect(node);

      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        this.dispose();
      });

      this.stream = stream;
      this.context = context;
      this.node = node;
      this.source = source;
      this.setMicState("ready");
      return true;
    } catch {
      this.setMicState("denied");
      return false;
    }
  }
}

function frameForRoom(samples: ArrayBuffer): Uint8Array {
  const out = new Uint8Array(VIEWER_FRAME_HEADER_BYTES + samples.byteLength);
  new DataView(out.buffer).setUint32(0, TALKBACK_SAMPLE_RATE, true);
  out.set(new Uint8Array(samples), VIEWER_FRAME_HEADER_BYTES);
  return out;
}

/* ------------------------------------------------------------------------ */
/* Host playback                                                             */
/* ------------------------------------------------------------------------ */

/** Scheduling lead so network jitter does not cause gaps. */
const JITTER_SECONDS = 0.12;
/** Drop the timeline if we fall this far behind (e.g. tab was throttled). */
const MAX_LAG_SECONDS = 1.5;

export class TalkbackReceiver {
  readonly output: GainNode;
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  private readonly analyserData: Uint8Array<ArrayBuffer>;
  private readonly cursors = new Map<number, number>();

  constructor(context: AudioContext) {
    this.context = context;
    this.output = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyserData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.output.connect(this.analyser);
  }

  /** Pre-fader level of whatever students are saying right now (0..1). */
  currentLevel(): number {
    this.analyser.getByteTimeDomainData(this.analyserData);
    return rmsFromTimeDomain(this.analyserData);
  }

  handleFrame(frame: ArrayBuffer): void {
    if (frame.byteLength <= HOST_FRAME_HEADER_BYTES) return;
    const view = new DataView(frame);
    const serial = view.getUint32(0, true);
    const sampleRate = view.getUint32(4, true);
    if (sampleRate < 8000 || sampleRate > 96000) return;

    const sampleCount = Math.floor((frame.byteLength - HOST_FRAME_HEADER_BYTES) / 2);
    if (sampleCount === 0) return;
    const pcm = new Int16Array(frame, HOST_FRAME_HEADER_BYTES, sampleCount);

    const buffer = this.context.createBuffer(1, sampleCount, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = pcm[i] / 32768;

    const now = this.context.currentTime;
    let startAt = this.cursors.get(serial) ?? 0;
    if (startAt < now + 0.01 || startAt > now + MAX_LAG_SECONDS) {
      startAt = now + JITTER_SECONDS;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.start(startAt);
    source.addEventListener("ended", () => source.disconnect());
    this.cursors.set(serial, startAt + buffer.duration);
  }

  forget(serial: number): void {
    this.cursors.delete(serial);
  }

  dispose(): void {
    this.output.disconnect();
    this.analyser.disconnect();
    this.cursors.clear();
  }
}
