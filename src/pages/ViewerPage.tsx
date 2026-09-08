import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { LevelMeter } from "../components/LevelMeter";
import { StatusBadge } from "../components/StatusBadge";
import { fetchViewerConfig, type ViewerConfig } from "../lib/api";
import { loadStreamPlayerSdk, type StreamPlayerApi } from "../lib/streamPlayerSdk";
import {
  RoomConnection,
  TalkbackSender,
  type MicState,
  type RoomStatus,
} from "../lib/talkback";
import { startWhepPlayback, stopWhepPlayback, type WhepSession } from "../lib/whep";
import { sanitizeName, type RoomState } from "../../shared/roomProtocol";

type PlayMode = "player" | "whep";
type PttMode = "hold" | "toggle";

const NAME_KEY = "training-center-viewer-name";
const PTT_MODE_KEY = "training-center-ptt-mode";

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      className="mute-btn__icon"
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9.5v5a1 1 0 0 0 1 1h2.6l4.2 3.3a.6.6 0 0 0 1-.5V5.7a.6.6 0 0 0-1-.5L7.6 8.5H5a1 1 0 0 0-1 1z" />
      {muted ? (
        <>
          <line x1="16" y1="9" x2="21" y2="14" />
          <line x1="21" y1="9" x2="16" y2="14" />
        </>
      ) : (
        <>
          <path d="M16 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 6a8.5 8.5 0 0 1 0 12" />
        </>
      )}
    </svg>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "IFRAME" ||
    target.isContentEditable
  );
}

export function ViewerPage() {
  const [config, setConfig] = useState<ViewerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PlayMode>("whep");
  const [watching, setWatching] = useState(false);
  const [muted, setMuted] = useState(false);
  const [playerSdkReady, setPlayerSdkReady] = useState(false);

  const [viewerName, setViewerName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [roomStatus, setRoomStatus] = useState<RoomStatus>("closed");
  const [roomState, setRoomState] = useState<RoomState>({
    talkbackEnabled: true,
    hostOnline: false,
    viewerCount: 0,
  });
  const [pttMode, setPttMode] = useState<PttMode>(
    () => (localStorage.getItem(PTT_MODE_KEY) === "toggle" ? "toggle" : "hold"),
  );
  const [talking, setTalking] = useState(false);
  const [micState, setMicState] = useState<MicState>("idle");
  const [micLevel, setMicLevel] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerApiRef = useRef<StreamPlayerApi | null>(null);
  const whepRef = useRef<WhepSession | null>(null);
  const roomRef = useRef<RoomConnection | null>(null);
  const senderRef = useRef<TalkbackSender | null>(null);
  const nameRef = useRef(viewerName);
  nameRef.current = viewerName;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const pttModeRef = useRef(pttMode);
  pttModeRef.current = pttMode;
  const talkbackAllowedRef = useRef(false);
  talkbackAllowedRef.current =
    roomStatus === "open" && roomState.talkbackEnabled && roomState.hostOnline;

  useEffect(() => {
    fetchViewerConfig()
      .then((data) => {
        setConfig(data);
        if (data.needsSetup) {
          setError(
            data.message ??
              "This class is not set up yet. Ask the instructor to create a live input in the studio.",
          );
          return;
        }
        // Ultra-low latency (WHEP) is the primary path: it gives us a native <video>
        // so Mute / talk-back work fully. Stream player stays available as a fallback.
        if (data.whepUrl) {
          setMode("whep");
        } else {
          setMode("player");
          setMuted(true); // iframe autoplay without a gesture must start muted
        }
      })
      .catch((err) => {
        const message =
          err instanceof Error ? err.message : "Could not load the live class";
        setError(
          message.includes("STREAM_LIVE_INPUT_UID")
            ? "This class is not set up yet. Ask the instructor to create a live input in the studio."
            : message,
        );
      });

    return () => {
      void stopWhepPlayback(whepRef.current);
      whepRef.current = null;
    };
  }, []);

  // Talk-back room: connect immediately so presence + permission state are ready
  // before the student needs to speak.
  useEffect(() => {
    const room = new RoomConnection({
      hello: () => ({ type: "hello", role: "viewer", name: sanitizeName(nameRef.current) }),
      onStatus: (status) => {
        setRoomStatus(status);
        if (status === "open") senderRef.current?.resync();
        if (status !== "open") setRoomState((prev) => ({ ...prev, hostOnline: false }));
      },
      onMessage: (message) => {
        if (message.type === "welcome" || message.type === "room") {
          setRoomState({
            talkbackEnabled: message.talkbackEnabled,
            hostOnline: message.hostOnline,
            viewerCount: message.viewerCount,
          });
          if (!message.talkbackEnabled || !message.hostOnline) {
            void senderRef.current?.setActive(false);
          }
        } else if (message.type === "error") {
          setError(`Talk-back: ${message.message}`);
        }
      },
    });
    roomRef.current = room;

    const sender = new TalkbackSender({
      connection: room,
      onLevel: setMicLevel,
      onMicState: setMicState,
      onActive: setTalking,
    });
    senderRef.current = sender;

    return () => {
      sender.dispose();
      room.close();
      if (roomRef.current === room) roomRef.current = null;
      if (senderRef.current === sender) senderRef.current = null;
    };
  }, []);

  const pressTalk = useCallback(() => {
    if (!talkbackAllowedRef.current) return;
    void senderRef.current?.setActive(true);
  }, []);

  const releaseTalk = useCallback(() => {
    void senderRef.current?.setActive(false);
  }, []);

  const toggleTalk = useCallback(() => {
    const sender = senderRef.current;
    if (!sender) return;
    if (sender.isActive) {
      void sender.setActive(false);
    } else if (talkbackAllowedRef.current) {
      void sender.setActive(true);
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => !prev);
  }, []);

  // Keyboard: Space = talk (hold or toggle), M = mute. Ignored while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (event.repeat) return;
        if (pttModeRef.current === "toggle") toggleTalk();
        else pressTalk();
      } else if (event.key === "m" || event.key === "M") {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        toggleMute();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      if (pttModeRef.current === "hold") releaseTalk();
    };
    const onBlur = () => {
      if (pttModeRef.current === "hold") releaseTalk();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [pressTalk, releaseTalk, toggleTalk, toggleMute]);

  // Local mute: only this viewer's playback, never the stream itself.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
    const api = playerApiRef.current;
    if (api) {
      try {
        api.muted = muted;
      } catch {
        // SDK not ready yet; applied when it attaches.
      }
    }
  }, [muted, mode, watching]);

  // Stream player (iframe) mode: attach the SDK so Mute can drive it without
  // reloading the player. Until it attaches, Mute falls back to a URL param reload.
  useEffect(() => {
    if (mode !== "player" || !config?.playerUrl) {
      playerApiRef.current = null;
      setPlayerSdkReady(false);
      return;
    }
    let cancelled = false;
    loadStreamPlayerSdk()
      .then((Stream) => {
        if (cancelled || !iframeRef.current) return;
        const api = Stream(iframeRef.current);
        playerApiRef.current = api;
        setPlayerSdkReady(true);
        try {
          api.muted = mutedRef.current;
        } catch {
          // Ignore; user can retry with the button.
        }
      })
      .catch(() => {
        // Player still works; Mute keeps using the iframe reload fallback.
      });
    return () => {
      cancelled = true;
      playerApiRef.current = null;
      setPlayerSdkReady(false);
    };
  }, [mode, config?.playerUrl]);

  const frozenPlayerSrcRef = useRef<string | null>(null);
  const playerSrc = (() => {
    if (!config?.playerUrl) return "";
    if (playerSdkReady && frozenPlayerSrcRef.current) return frozenPlayerSrcRef.current;
    const src = `${config.playerUrl}?autoplay=true&muted=${muted ? "true" : "false"}`;
    frozenPlayerSrcRef.current = src;
    return src;
  })();

  async function watchWhep() {
    if (!config?.whepUrl) {
      setError("No WHEP playback URL available for this live input.");
      return;
    }
    setError(null);
    try {
      await stopWhepPlayback(whepRef.current);
      const session = await startWhepPlayback(config.whepUrl);
      whepRef.current = session;
      if (videoRef.current) {
        videoRef.current.srcObject = session.remoteStream;
        videoRef.current.muted = mutedRef.current;
        await videoRef.current.play().catch(() => undefined);
      }
      setWatching(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not start playback. Is the class live?",
      );
      setWatching(false);
    }
  }

  async function stopWatching() {
    await stopWhepPlayback(whepRef.current);
    whepRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setWatching(false);
  }

  function updateName(next: string) {
    setViewerName(next);
    localStorage.setItem(NAME_KEY, next);
    roomRef.current?.send({ type: "rename", name: sanitizeName(next) });
  }

  function updatePttMode(next: PttMode) {
    setPttMode(next);
    localStorage.setItem(PTT_MODE_KEY, next);
    releaseTalk();
  }

  const live = (config?.status ?? "").toLowerCase().includes("connected") || watching;
  const talkbackAllowed =
    roomStatus === "open" && roomState.talkbackEnabled && roomState.hostOnline;

  const pttStatus = (() => {
    if (roomStatus !== "open") return "Connecting to the classroom…";
    if (!roomState.hostOnline) return "Instructor is not in the studio yet.";
    if (!roomState.talkbackEnabled) return "Instructor has turned talk-back off.";
    if (micState === "denied") return "Microphone blocked — allow it in your browser settings.";
    if (micState === "requesting") return "Waiting for microphone permission…";
    if (talking) return "You are live to the instructor.";
    return pttMode === "hold"
      ? "Hold the button (or Space) to talk. Release to mute."
      : "Press the button (or Space) to talk. Press again to mute.";
  })();

  return (
    <main className="page viewer-page">
      <header className="viewer-top">
        <div className="viewer-top__brand">
          <BrandMark size="md" as="h1" />
          <p className="lede">
            {config?.name ?? "Live class"} — press Watch when your instructor starts class.
          </p>
        </div>
        <StatusBadge live={live} label={live ? "In class" : "Waiting"} />
      </header>

      <section className="viewer-stage">
        {mode === "player" && config?.playerUrl ? (
          <div className="player-frame">
            <iframe
              ref={iframeRef}
              title="Training Center player"
              src={playerSrc}
              allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="player-frame player-frame--native">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              controls
              onVolumeChange={(e) => {
                const el = e.currentTarget;
                if (el.muted !== mutedRef.current) setMuted(el.muted);
              }}
            />
          </div>
        )}

        <div className="viewer-controlbar">
          {mode === "whep" ? (
            <button
              type="button"
              className={`btn btn--xl ${watching ? "btn--danger" : "btn--primary"}`}
              onClick={() => void (watching ? stopWatching() : watchWhep())}
            >
              {watching ? "Stop watching" : "Watch"}
            </button>
          ) : null}

          <button
            type="button"
            className={`btn btn--xl mute-btn${muted ? " is-muted" : ""}`}
            aria-pressed={muted}
            onClick={toggleMute}
            title="Mute or unmute the class audio on this device only (M)"
          >
            <SpeakerIcon muted={muted} />
            {muted ? "Unmute" : "Mute"}
            <span className="mute-btn__hint">only for you</span>
          </button>

          <div className={`ptt${talking ? " is-talking" : ""}${!talkbackAllowed ? " is-disabled" : ""}`}>
            <button
              type="button"
              className={`btn btn--xl ptt-btn${talking ? " is-talking" : ""}`}
              disabled={!talkbackAllowed || micState === "denied"}
              aria-pressed={talking}
              aria-label={talking ? "Talking — release to mute" : "Talk to the instructor"}
              onPointerDown={(e) => {
                if (e.button !== 0 && e.pointerType === "mouse") return;
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                if (pttMode === "toggle") toggleTalk();
                else pressTalk();
              }}
              onPointerUp={() => {
                if (pttMode === "hold") releaseTalk();
              }}
              onPointerCancel={() => {
                if (pttMode === "hold") releaseTalk();
              }}
              onLostPointerCapture={() => {
                if (pttMode === "hold") releaseTalk();
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <span className="ptt-btn__dot" aria-hidden="true" />
              {talking ? "Talking…" : pttMode === "hold" ? "Hold to talk" : "Talk"}
            </button>
            <div className="ptt__meta">
              <LevelMeter level={talking ? micLevel : 0} label="Your microphone" />
              <p className="ptt__status">{pttStatus}</p>
            </div>
          </div>
        </div>

        <div className="viewer-actions">
          <div className="viewer-options">
            <label className="field field--compact">
              <span>Your name (shown to the instructor when you talk)</span>
              <input
                value={viewerName}
                maxLength={40}
                placeholder="e.g. Jordan"
                onChange={(e) => updateName(e.target.value)}
              />
            </label>
            <div className="field field--compact">
              <span>Talk button</span>
              <div className="mode-toggle" role="group" aria-label="Talk button behaviour">
                <button
                  type="button"
                  className={`btn btn--toggle${pttMode === "hold" ? " is-active" : ""}`}
                  onClick={() => updatePttMode("hold")}
                >
                  Hold to talk
                </button>
                <button
                  type="button"
                  className={`btn btn--toggle${pttMode === "toggle" ? " is-active" : ""}`}
                  onClick={() => updatePttMode("toggle")}
                >
                  Press to toggle
                </button>
              </div>
            </div>
          </div>

          <div className="mode-toggle" role="group" aria-label="Playback mode">
            <button
              type="button"
              className={`btn btn--toggle${mode === "whep" ? " is-active" : ""}`}
              onClick={() => {
                void stopWatching();
                setMode("whep");
              }}
            >
              Ultra-low latency
            </button>
            <button
              type="button"
              className={`btn btn--toggle${mode === "player" ? " is-active" : ""}`}
              disabled={!config?.playerUrl}
              onClick={() => {
                void stopWatching();
                setMode("player");
              }}
            >
              Stream player
            </button>
          </div>

          {mode === "player" ? (
            <p className="hint">
              Stream player loads automatically. If the class is not live yet, you will see a waiting
              message.
            </p>
          ) : null}

          <p className="hint">
            Shortcuts: <kbd>Space</kbd> talk · <kbd>M</kbd> mute. Headphones help avoid echo when
            you talk.
          </p>

          {error ? <p className="error-banner">{error}</p> : null}
          {config?.note ? <p className="hint">{config.note}</p> : null}
        </div>
      </section>
    </main>
  );
}
