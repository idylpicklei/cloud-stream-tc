/**
 * Wire protocol for the Training Center "class room" WebSocket relay.
 *
 * Cloudflare Stream live inputs are one-way (WHIP in, WHEP out), so student
 * talk-back rides a separate WebSocket to the `ClassRoom` Durable Object, which
 * relays it to whichever host studio tabs are connected.
 *
 * Text frames carry JSON control messages (below). Binary frames carry PCM audio:
 *
 *   viewer -> room :  [u32 LE sampleRate][Int16 LE samples...]
 *   room   -> host :  [u32 LE viewerSerial][u32 LE sampleRate][Int16 LE samples...]
 */

export const ROOM_WS_PATH = "/api/room/ws";

/** Viewer capture rate. Low enough to keep bandwidth ~256 kbps while talking. */
export const TALKBACK_SAMPLE_RATE = 16000;

/** Hard cap on one audio frame (a 100 ms chunk at 16 kHz is ~3.2 KB). */
export const MAX_AUDIO_FRAME_BYTES = 32 * 1024;

export const VIEWER_FRAME_HEADER_BYTES = 4;
export const HOST_FRAME_HEADER_BYTES = 8;

export type RoomRole = "host" | "viewer";

export type ClientMessage =
  | { type: "hello"; role: "host"; token: string }
  | { type: "hello"; role: "viewer"; name?: string }
  | { type: "ptt"; active: boolean }
  | { type: "rename"; name: string }
  | { type: "talkback"; enabled: boolean };

export interface RoomState {
  /** Host has allowed students to use push-to-talk. */
  talkbackEnabled: boolean;
  /** At least one host studio tab is connected. */
  hostOnline: boolean;
  viewerCount: number;
}

export type ServerMessage =
  | ({ type: "welcome"; role: RoomRole; serial: number } & RoomState)
  | ({ type: "room" } & RoomState)
  | { type: "ptt"; serial: number; name: string; active: boolean }
  | { type: "error"; message: string };

export const MAX_NAME_LENGTH = 40;

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
}
