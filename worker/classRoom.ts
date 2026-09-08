/**
 * ClassRoom Durable Object — WebSocket relay for student talk-back.
 *
 * One instance per live input. Viewers and host studio tabs connect over
 * WebSocket; the room forwards push-to-talk PCM audio from viewers to hosts and
 * keeps everyone informed about presence and whether talk-back is allowed.
 *
 * Uses the WebSocket Hibernation API so an idle room costs nothing.
 */

import { DurableObject } from "cloudflare:workers";
import {
  HOST_FRAME_HEADER_BYTES,
  MAX_AUDIO_FRAME_BYTES,
  VIEWER_FRAME_HEADER_BYTES,
  sanitizeName,
  type ClientMessage,
  type RoomState,
  type ServerMessage,
} from "../shared/roomProtocol";
import type { Env } from "./index";

interface Attachment {
  role: "pending" | "host" | "viewer";
  serial: number;
  name: string;
  ptt: boolean;
}

const TALKBACK_KEY = "talkbackEnabled";

export class ClassRoom extends DurableObject<Env> {
  private talkbackEnabled = true;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<boolean>(TALKBACK_KEY);
      if (typeof stored === "boolean") this.talkbackEnabled = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const attachment: Attachment = {
      role: "pending",
      serial: randomSerial(),
      name: "",
      ptt: false,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) return;

    if (typeof message !== "string") {
      this.relayAudio(ws, attachment, message);
      return;
    }

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    if (parsed.type === "hello") {
      this.handleHello(ws, attachment, parsed);
      return;
    }

    if (attachment.role === "pending") {
      this.reject(ws, "Say hello first");
      return;
    }

    switch (parsed.type) {
      case "ptt": {
        if (attachment.role !== "viewer") return;
        const active = Boolean(parsed.active) && this.talkbackEnabled;
        if (attachment.ptt === active) return;
        attachment.ptt = active;
        ws.serializeAttachment(attachment);
        this.sendToHosts({
          type: "ptt",
          serial: attachment.serial,
          name: attachment.name || "Student",
          active,
        });
        return;
      }
      case "rename": {
        if (attachment.role !== "viewer") return;
        attachment.name = sanitizeName(parsed.name);
        ws.serializeAttachment(attachment);
        return;
      }
      case "talkback": {
        if (attachment.role !== "host") return;
        const enabled = Boolean(parsed.enabled);
        if (enabled === this.talkbackEnabled) return;
        this.talkbackEnabled = enabled;
        await this.ctx.storage.put(TALKBACK_KEY, enabled);
        if (!enabled) this.silenceAllViewers();
        this.broadcastRoomState();
        return;
      }
      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = readAttachment(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    this.afterDisconnect(ws, attachment);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = readAttachment(ws);
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // Already closed.
    }
    this.afterDisconnect(ws, attachment);
  }

  private handleHello(ws: WebSocket, attachment: Attachment, hello: ClientMessage): void {
    if (hello.type !== "hello") return;

    if (hello.role === "host") {
      const expected = this.env.HOST_TOKEN;
      if (!expected || hello.token !== expected) {
        this.reject(ws, "Invalid host token");
        return;
      }
      attachment.role = "host";
      attachment.name = "Instructor";
    } else {
      attachment.role = "viewer";
      attachment.name = sanitizeName(hello.name);
    }
    attachment.ptt = false;
    ws.serializeAttachment(attachment);

    const state = this.roomState();
    send(ws, { type: "welcome", role: attachment.role, serial: attachment.serial, ...state });
    this.broadcastRoomState({ skip: ws });
  }

  private relayAudio(ws: WebSocket, attachment: Attachment, frame: ArrayBuffer): void {
    if (attachment.role !== "viewer" || !attachment.ptt || !this.talkbackEnabled) return;
    if (
      frame.byteLength <= VIEWER_FRAME_HEADER_BYTES ||
      frame.byteLength > MAX_AUDIO_FRAME_BYTES
    ) {
      return;
    }

    const hosts = this.sockets().filter(({ att }) => att.role === "host");
    if (hosts.length === 0) return;

    const out = new Uint8Array(HOST_FRAME_HEADER_BYTES + frame.byteLength - VIEWER_FRAME_HEADER_BYTES);
    new DataView(out.buffer).setUint32(0, attachment.serial, true);
    // Copy the viewer's sampleRate header + samples after our serial prefix.
    out.set(new Uint8Array(frame), HOST_FRAME_HEADER_BYTES - VIEWER_FRAME_HEADER_BYTES);

    for (const { socket } of hosts) {
      if (socket === ws) continue;
      try {
        socket.send(out);
      } catch {
        // Dropped socket; close handler will tidy up.
      }
    }
  }

  private afterDisconnect(ws: WebSocket, attachment: Attachment | null): void {
    if (attachment?.role === "viewer" && attachment.ptt) {
      this.sendToHosts({
        type: "ptt",
        serial: attachment.serial,
        name: attachment.name || "Student",
        active: false,
      });
    }
    // The closing socket may still be listed by getWebSockets() here; leave it out.
    this.broadcastRoomState({ exclude: ws });
  }

  private silenceAllViewers(): void {
    for (const { socket, att } of this.sockets()) {
      if (att.role === "viewer" && att.ptt) {
        att.ptt = false;
        socket.serializeAttachment(att);
        this.sendToHosts({
          type: "ptt",
          serial: att.serial,
          name: att.name || "Student",
          active: false,
        });
      }
    }
  }

  private roomState(exclude?: WebSocket): RoomState {
    let hostOnline = false;
    let viewerCount = 0;
    for (const { socket, att } of this.sockets()) {
      if (socket === exclude) continue;
      if (att.role === "host") hostOnline = true;
      if (att.role === "viewer") viewerCount += 1;
    }
    return { talkbackEnabled: this.talkbackEnabled, hostOnline, viewerCount };
  }

  /**
   * @param skip    socket that already received this state in its welcome
   * @param exclude socket that is leaving: neither counted nor messaged
   */
  private broadcastRoomState(options: { skip?: WebSocket; exclude?: WebSocket } = {}): void {
    const state = this.roomState(options.exclude);
    const message: ServerMessage = { type: "room", ...state };
    for (const { socket, att } of this.sockets()) {
      if (att.role === "pending" || socket === options.skip || socket === options.exclude) {
        continue;
      }
      send(socket, message);
    }
  }

  private sendToHosts(message: ServerMessage): void {
    for (const { socket, att } of this.sockets()) {
      if (att.role === "host") send(socket, message);
    }
  }

  private reject(ws: WebSocket, reason: string): void {
    send(ws, { type: "error", message: reason });
    try {
      ws.close(4001, reason);
    } catch {
      // Already closed.
    }
  }

  private sockets(): Array<{ socket: WebSocket; att: Attachment }> {
    const list: Array<{ socket: WebSocket; att: Attachment }> = [];
    for (const socket of this.ctx.getWebSockets()) {
      const att = readAttachment(socket);
      if (att) list.push({ socket, att });
    }
    return list;
  }
}

function readAttachment(ws: WebSocket): Attachment | null {
  try {
    const att = ws.deserializeAttachment() as Attachment | null;
    return att && typeof att === "object" ? att : null;
  } catch {
    return null;
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Socket already gone.
  }
}

function randomSerial(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] || 1;
}
