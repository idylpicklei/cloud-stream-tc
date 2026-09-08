import { useEffect, useMemo, useRef, useState } from "react";
import { AudioChannelCard } from "../components/AudioChannelCard";
import { BrandMark } from "../components/BrandMark";
import { LevelMeter } from "../components/LevelMeter";
import { SourceRow } from "../components/SourceRow";
import { StatusBadge } from "../components/StatusBadge";
import {
  createLiveInput,
  fetchHealth,
  fetchHostSession,
  pingHost,
  type HealthStatus,
  type HostSession,
} from "../lib/api";
import {
  AudioMixer,
  listAudioInputDevices,
  listVideoInputDevices,
  type MixerChannel,
} from "../lib/audioMixer";
import { RoomConnection, TalkbackReceiver, type RoomStatus } from "../lib/talkback";
import {
  VideoCompositor,
  type PipCorner,
  type PipSize,
} from "../lib/videoCompositor";
import { startWhipBroadcast, stopWhipBroadcast, type WhipSession } from "../lib/whip";
import type { SlideshowDeck } from "../lib/slideshow";
import type { RoomState } from "../../shared/roomProtocol";

const TOKEN_KEY = "training-center-host-token";
const TALKBACK_CHANNEL_ID = "__talkback__";
const TALKBACK_MONITOR_KEY = "training-center-talkback-monitor";

const ROLE_PRESETS = [
  { id: "instructor", label: "Instructor mic" },
  { id: "room", label: "Room / classroom mic" },
  { id: "laptop", label: "Laptop / system audio" },
  { id: "extra", label: "Extra input" },
] as const;

type PipSource = "off" | "slideshow" | "camera" | "screen";

const CORNER_OPTIONS: { id: PipCorner; label: string }[] = [
  { id: "top-left", label: "Top left" },
  { id: "top-right", label: "Top right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "bottom-right", label: "Bottom right" },
];

const SIZE_OPTIONS: { id: PipSize; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

function pipSourceLabel(source: PipSource): string {
  switch (source) {
    case "slideshow":
      return "slides";
    case "camera":
      return "2nd camera";
    case "screen":
      return "screen share";
    default:
      return "PiP";
  }
}

function SwapIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="13" y="12" width="6" height="5" rx="1" />
      <path d="M7 8h5M7 8l2-2M7 8l2 2" />
    </svg>
  );
}

function FullscreenIcon({ exit }: { exit: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {exit ? (
        <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      ) : (
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      )}
    </svg>
  );
}

export function HostPage() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [unlocked, setUnlocked] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [session, setSession] = useState<HostSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [channels, setChannels] = useState<MixerChannel[]>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [addDeviceId, setAddDeviceId] = useState("");
  const [addRole, setAddRole] = useState<string>(ROLE_PRESETS[0].id);

  const [pipSource, setPipSource] = useState<PipSource>("off");
  const [pipCorner, setPipCorner] = useState<PipCorner>("bottom-right");
  const [pipSize, setPipSize] = useState<PipSize>("medium");
  const [secondaryCameraId, setSecondaryCameraId] = useState("");
  const [slideMeta, setSlideMeta] = useState<{ name: string; index: number; total: number } | null>(
    null,
  );
  const [secondaryLabel, setSecondaryLabel] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [swapped, setSwapped] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);

  const [roomStatus, setRoomStatus] = useState<RoomStatus>("closed");
  const [roomState, setRoomState] = useState<RoomState>({
    talkbackEnabled: true,
    hostOnline: true,
    viewerCount: 0,
  });
  const [talkers, setTalkers] = useState<{ serial: number; name: string }[]>([]);
  const [talkbackInMix, setTalkbackInMix] = useState(false);
  const [talkbackMonitor, setTalkbackMonitor] = useState(
    () => localStorage.getItem(TALKBACK_MONITOR_KEY) !== "off",
  );

  const previewHostRef = useRef<HTMLDivElement>(null);
  const previewShellRef = useRef<HTMLDivElement>(null);
  const mixerRef = useRef<AudioMixer | null>(null);
  const compositorRef = useRef<VideoCompositor | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const secondaryStreamRef = useRef<MediaStream | null>(null);
  const deckRef = useRef<SlideshowDeck | null>(null);
  const whipRef = useRef<WhipSession | null>(null);
  const slideInputRef = useRef<HTMLInputElement>(null);
  const roomRef = useRef<RoomConnection | null>(null);
  const receiverRef = useRef<TalkbackReceiver | null>(null);
  const monitorGainRef = useRef<GainNode | null>(null);
  const talkersRef = useRef(new Map<number, string>());
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const viewerLink = useMemo(() => {
    if (typeof window === "undefined") return "/watch";
    return `${window.location.origin}/watch`;
  }, []);

  const secondaryCameras = useMemo(
    () => cameras.filter((cam) => cam.deviceId && cam.deviceId !== cameraId),
    [cameras, cameraId],
  );

  const deviceChannels = useMemo(
    () => channels.filter((channel) => channel.kind === "device"),
    [channels],
  );

  const cameraLabel = cameras.find((cam) => cam.deviceId === cameraId)?.label || "Camera";
  const pipBadge = !cameraOn || swapped ? "Full stage" : "PiP";
  const secondaryCameraLabel =
    cameras.find((cam) => cam.deviceId === secondaryCameraId)?.label ||
    secondaryCameras[0]?.label ||
    "";

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    ensureCompositor();
    mountPreviewCanvas();
  }, [unlocked]);

  useEffect(() => {
    const onChange = () => {
      setPreviewFullscreen(
        document.fullscreenElement != null &&
          document.fullscreenElement === previewShellRef.current,
      );
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Talk-back relay: stay connected the whole time the studio is open so the
  // instructor can hear students before, during, and after going live.
  useEffect(() => {
    if (!unlocked) return;
    const room = new RoomConnection({
      hello: () => ({ type: "hello", role: "host", token: tokenRef.current.trim() }),
      onStatus: setRoomStatus,
      onMessage: (message) => {
        switch (message.type) {
          case "welcome":
          case "room":
            setRoomState({
              talkbackEnabled: message.talkbackEnabled,
              hostOnline: true,
              viewerCount: message.viewerCount,
            });
            if (message.type === "welcome") {
              talkersRef.current.clear();
              setTalkers([]);
            }
            break;
          case "ptt":
            if (message.active) {
              talkersRef.current.set(message.serial, message.name);
            } else {
              talkersRef.current.delete(message.serial);
              receiverRef.current?.forget(message.serial);
            }
            setTalkers(
              [...talkersRef.current.entries()].map(([serial, name]) => ({ serial, name })),
            );
            break;
          case "error":
            setError(`Talk-back relay: ${message.message}`);
            break;
          default:
            break;
        }
      },
      onBinary: (frame) => {
        receiverRef.current?.handleFrame(frame);
      },
    });
    roomRef.current = room;
    return () => {
      room.close();
      if (roomRef.current === room) roomRef.current = null;
    };
  }, [unlocked]);

  useEffect(() => {
    return () => {
      void stopWhipBroadcast(whipRef.current);
      whipRef.current = null;
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      secondaryStreamRef.current?.getTracks().forEach((t) => t.stop());
      deckRef.current?.dispose();
      compositorRef.current?.dispose();
      receiverRef.current?.dispose();
      mixerRef.current?.dispose();
    };
  }, []);

  function ensureCompositor(): VideoCompositor {
    if (!compositorRef.current) {
      const compositor = new VideoCompositor();
      compositorRef.current = compositor;
      compositor.setCorner(pipCorner);
      compositor.setPipSize(pipSize);
      compositor.start(30);
      const host = previewHostRef.current;
      if (host) {
        host.replaceChildren(compositor.canvas);
        compositor.canvas.className = "camera-preview composition-preview";
      }
    }
    return compositorRef.current;
  }

  function mountPreviewCanvas(): void {
    const compositor = compositorRef.current;
    const host = previewHostRef.current;
    if (!compositor || !host) return;
    if (compositor.canvas.parentElement !== host) {
      host.replaceChildren(compositor.canvas);
      compositor.canvas.className = "camera-preview composition-preview";
    }
  }

  async function unlockStudio() {
    setError(null);
    setBusy(true);
    try {
      localStorage.setItem(TOKEN_KEY, token.trim());
      await pingHost(token.trim());
      const hostSession = await fetchHostSession(token.trim());
      setSession(hostSession);
      setUnlocked(true);
      if (hostSession.needsLiveInput && hostSession.message) {
        setError(hostSession.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock the studio");
      setUnlocked(false);
      setBusy(false);
      return;
    }

    await setupDevices();
    setBusy(false);
  }

  async function ensureMixer() {
    if (mixerRef.current) return;
    try {
      const mixer = new AudioMixer();
      mixerRef.current = mixer;

      // Student talk-back: monitor on the instructor's speakers, and optionally
      // ride into the live mix as a regular (initially muted) mixer channel.
      const receiver = new TalkbackReceiver(mixer.audioContext);
      receiverRef.current = receiver;
      const monitor = mixer.audioContext.createGain();
      monitor.gain.value = talkbackMonitor ? 1 : 0;
      receiver.output.connect(monitor);
      monitor.connect(mixer.audioContext.destination);
      monitorGainRef.current = monitor;
      mixer.addExternalSource(TALKBACK_CHANNEL_ID, "Student talk-back", receiver.output, {
        muted: true,
      });
      setTalkbackInMix(false);

      mixer.onLevels((next) => {
        setLevels({ ...next, [TALKBACK_CHANNEL_ID]: receiver.currentLevel() });
      });
      syncChannelState();
    } catch {
      // AudioContext unavailable — rare (locked-down browser)
    }
  }

  function setTalkbackAllowed(enabled: boolean) {
    setRoomState((prev) => ({ ...prev, talkbackEnabled: enabled }));
    roomRef.current?.send({ type: "talkback", enabled });
    if (!enabled) {
      talkersRef.current.clear();
      setTalkers([]);
    }
  }

  function applyTalkbackInMix(enabled: boolean) {
    mixerRef.current?.setMuted(TALKBACK_CHANNEL_ID, !enabled);
    setTalkbackInMix(enabled);
    syncChannelState();
  }

  function applyTalkbackMonitor(enabled: boolean) {
    const gain = monitorGainRef.current;
    const context = mixerRef.current?.audioContext;
    if (gain && context) {
      gain.gain.setTargetAtTime(enabled ? 1 : 0, context.currentTime, 0.02);
    }
    localStorage.setItem(TALKBACK_MONITOR_KEY, enabled ? "on" : "off");
    setTalkbackMonitor(enabled);
  }

  function toggleSwap() {
    const compositor = ensureCompositor();
    const next = !compositor.isSwapped;
    compositor.setSwapped(next);
    setSwapped(next);
  }

  async function togglePreviewFullscreen() {
    const shell = previewShellRef.current;
    if (!shell) return;
    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
    } catch {
      setError("Fullscreen is not available in this browser.");
    }
  }

  async function toggleCamera(on: boolean) {
    setError(null);
    const compositor = ensureCompositor();
    if (!on) {
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
      await compositor.setMainStream(null);
      compositor.setMainEnabled(false);
      setCameraOn(false);
      return;
    }
    compositor.setMainEnabled(true);
    setCameraOn(true);
    const deviceId = cameraId || cameras[0]?.deviceId;
    if (!deviceId) {
      setError("No camera found. Plug one in (or allow access), then try again.");
      return;
    }
    try {
      await attachCamera(deviceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that camera");
    }
  }

  async function setupDevices() {
    await ensureMixer();
    try {
      const audioDevices = await listAudioInputDevices();
      const videoDevices = await listVideoInputDevices();
      setMics(audioDevices);
      setCameras(videoDevices);
      if (!cameraId && videoDevices[0]) setCameraId(videoDevices[0].deviceId);
      if (!addDeviceId && audioDevices[0]) setAddDeviceId(audioDevices[0].deviceId);
      const other = videoDevices.find((d) => d.deviceId !== videoDevices[0]?.deviceId);
      if (!secondaryCameraId && other) setSecondaryCameraId(other.deviceId);

      if (videoDevices[0]) {
        await attachCamera(videoDevices[0].deviceId);
      } else {
        ensureCompositor();
        mountPreviewCanvas();
        setError((prev) =>
          prev ??
          "No camera found yet. Plug one in (or allow access), then pick it under Camera.",
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Studio opened, but devices need attention: ${err.message}`
          : "Studio opened, but camera/mic setup needs attention.",
      );
      await ensureMixer();
      ensureCompositor();
      mountPreviewCanvas();
    }
  }

  async function attachCamera(deviceId: string) {
    setCameraId(deviceId);
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      cameraStreamRef.current = stream;
      const compositor = ensureCompositor();
      compositor.setMainEnabled(true);
      setCameraOn(true);
      await compositor.setMainStream(stream);
      mountPreviewCanvas();
    } catch (err) {
      cameraStreamRef.current = null;
      throw err instanceof Error ? err : new Error("Could not open that camera");
    }
  }

  function syncChannelState() {
    setChannels(mixerRef.current?.list() ?? []);
  }

  async function addAudioChannel() {
    if (!mixerRef.current || !addDeviceId) return;
    setError(null);
    try {
      const role = ROLE_PRESETS.find((r) => r.id === addRole)?.label ?? "Audio input";
      const device = mics.find((m) => m.deviceId === addDeviceId);
      await mixerRef.current.addDevice(
        addDeviceId,
        `${role}${device?.label ? ` — ${device.label}` : ""}`,
      );
      syncChannelState();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not open that microphone. Check browser permissions.",
      );
    }
  }

  async function createInput() {
    setBusy(true);
    setError(null);
    try {
      const created = await createLiveInput(token.trim(), "Training Center class");
      setSession(created);
      if (created.message) setError(created.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create live input");
    } finally {
      setBusy(false);
    }
  }

  function stopSecondaryStream() {
    secondaryStreamRef.current?.getTracks().forEach((t) => t.stop());
    secondaryStreamRef.current = null;
    setSecondaryLabel(null);
  }

  function applyPipLayout(corner = pipCorner, size = pipSize) {
    const compositor = compositorRef.current;
    if (!compositor) return;
    compositor.setCorner(corner);
    compositor.setPipSize(size);
  }

  async function applyPipSource(next: PipSource) {
    setError(null);
    const compositor = ensureCompositor();
    mountPreviewCanvas();

    if (next === "off") {
      stopSecondaryStream();
      compositor.clearPip();
      setPipSource("off");
      return;
    }

    if (next === "slideshow") {
      stopSecondaryStream();
      const slide = deckRef.current?.current() ?? null;
      if (!slide) {
        setPipSource("slideshow");
        compositor.clearPip();
        setError("Upload a slideshow (PDF or images) before enabling slide PiP.");
        return;
      }
      compositor.setPipStill(slide);
      setPipSource("slideshow");
      return;
    }

    if (next === "camera") {
      const deviceId = secondaryCameraId || secondaryCameras[0]?.deviceId;
      if (!deviceId) {
        setError("No second camera available. Plug one in or choose Screen share.");
        return;
      }
      stopSecondaryStream();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        secondaryStreamRef.current = stream;
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (secondaryStreamRef.current === stream) {
            void applyPipSource("off");
          }
        });
        await compositor.setPipVideoStream(stream);
        setSecondaryCameraId(deviceId);
        const label =
          cameras.find((c) => c.deviceId === deviceId)?.label || "Second camera";
        setSecondaryLabel(label);
        setPipSource("camera");
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not open the second camera",
        );
      }
      return;
    }

    if (next === "screen") {
      stopSecondaryStream();
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        secondaryStreamRef.current = stream;
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (secondaryStreamRef.current === stream) {
            void applyPipSource("off");
          }
        });
        await compositor.setPipVideoStream(stream);
        setSecondaryLabel("Screen / tab share");
        setPipSource("screen");
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Screen share was cancelled or is unavailable.",
        );
      }
    }
  }

  async function onSlidesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      const { SlideshowDeck } = await import("../lib/slideshow");
      const deck = await SlideshowDeck.fromFiles(files);
      deckRef.current?.dispose();
      deckRef.current = deck;
      setSlideMeta({ name: deck.name, index: deck.currentIndex, total: deck.length });
      const compositor = ensureCompositor();
      mountPreviewCanvas();
      if (pipSource === "slideshow" || pipSource === "off") {
        stopSecondaryStream();
        compositor.setPipStill(deck.current());
        setPipSource("slideshow");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load slideshow");
    } finally {
      setBusy(false);
      if (slideInputRef.current) slideInputRef.current.value = "";
    }
  }

  function stepSlide(direction: -1 | 1) {
    const deck = deckRef.current;
    if (!deck || deck.length === 0) return;
    const slide = direction < 0 ? deck.prev() : deck.next();
    setSlideMeta({ name: deck.name, index: deck.currentIndex, total: deck.length });
    if (pipSource === "slideshow" && slide) {
      compositorRef.current?.setPipStill(slide);
    }
  }

  function clearSlideshow() {
    deckRef.current?.dispose();
    deckRef.current = null;
    setSlideMeta(null);
    if (pipSource === "slideshow") {
      compositorRef.current?.clearPip();
      setPipSource("off");
    }
  }

  async function startClass() {
    setError(null);
    setBusy(true);
    try {
      const refreshed = await fetchHostSession(token.trim());
      setSession(refreshed);
      if (!refreshed.whipUrl) {
        throw new Error(
          "No live input yet. Click “Create Cloudflare live input” (or set STREAM_LIVE_INPUT_UID), then try again.",
        );
      }

      const mixer = mixerRef.current;
      if (!mixer) throw new Error("Audio mixer not ready");
      await mixer.resume();

      if (mixer.list().filter((channel) => channel.kind === "device").length === 0) {
        throw new Error("Add at least one microphone before going live.");
      }
      if (!cameraStreamRef.current && cameraOn) {
        throw new Error(
          "Turn on your camera before going live, or switch the Main camera feed off to teach with slides / audio only.",
        );
      }

      const compositor = ensureCompositor();
      compositor.setMainEnabled(cameraOn);
      await compositor.setMainStream(cameraStreamRef.current);
      mountPreviewCanvas();
      applyPipLayout();

      // Re-apply active PiP so the composition is current at go-live.
      if (pipSource === "slideshow") {
        const slide = deckRef.current?.current() ?? null;
        if (slide) compositor.setPipStill(slide);
      } else if (
        (pipSource === "camera" || pipSource === "screen") &&
        secondaryStreamRef.current
      ) {
        await compositor.setPipVideoStream(secondaryStreamRef.current);
      }

      const composed = compositor.start(30);
      const videoTrack = composed.getVideoTracks()[0];
      const audioTrack = mixer.mixedAudioTrack;
      if (!videoTrack || !audioTrack) {
        throw new Error("Composed video or mixed audio track is missing.");
      }

      const outbound = new MediaStream([videoTrack, audioTrack]);
      whipRef.current = await startWhipBroadcast(refreshed.whipUrl, outbound);
      setLive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start class");
      setLive(false);
    } finally {
      setBusy(false);
    }
  }

  async function endClass() {
    setBusy(true);
    setError(null);
    try {
      await stopWhipBroadcast(whipRef.current);
      whipRef.current = null;
      setLive(false);
      // Keep compositor + camera + mixer running for a quick re-live.
      mountPreviewCanvas();
      if (cameraStreamRef.current && cameraOn) {
        await compositorRef.current?.setMainStream(cameraStreamRef.current);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end class cleanly");
    } finally {
      setBusy(false);
    }
  }

  async function copyViewerLink() {
    await navigator.clipboard.writeText(viewerLink);
  }

  if (!unlocked) {
    return (
      <main className="page host-gate">
        <div className="gate-panel">
          <BrandMark size="lg" as="h1" />
          <p className="lede">
            Enter the shared host password to set up camera and microphones, then start class.
          </p>

          <label className="field">
            <span>Host password</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Shared studio password"
              autoComplete="current-password"
            />
          </label>

          <button
            type="button"
            className="btn btn--primary btn--xl"
            disabled={busy || !token.trim()}
            onClick={() => void unlockStudio()}
          >
            {busy ? "Opening…" : "Open studio"}
          </button>

          {error ? <p className="error-banner">{error}</p> : null}

          {health ? (
            <ul className="setup-checklist">
              <li className={health.hasHostToken ? "ok" : "bad"}>Host token configured</li>
              <li className={health.hasAccountId && health.hasStreamToken ? "ok" : "bad"}>
                Stream API credentials configured
              </li>
              <li className={health.hasLiveInputUid ? "ok" : "warn"}>
                Live input UID {health.hasLiveInputUid ? "set" : "missing (create one after unlock)"}
              </li>
              <li className={health.hasCustomerCode ? "ok" : "warn"}>
                Customer code {health.hasCustomerCode ? "set" : "missing (needed for Stream player)"}
              </li>
            </ul>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className="page host-studio">
      <header className="studio-top">
        <div className="studio-top__brand">
          <BrandMark size="md" as="h1" />
          <p className="lede">
            Compose camera + picture-in-picture, mix audio, then press Start class.
          </p>
        </div>
        <StatusBadge live={live} />
      </header>

      <section className="studio-hero" aria-label="Composition preview and go-live controls">
        <div ref={previewShellRef} className="preview-shell">
          <div ref={previewHostRef} className="composition-host" />
          <div className="preview-toolbar">
            <button
              type="button"
              className={`btn btn--overlay${swapped ? " is-active" : ""}`}
              disabled={pipSource === "off" || !cameraOn}
              aria-pressed={swapped}
              title={
                pipSource === "off"
                  ? "Turn on a slideshow, second camera or screen share to swap layouts"
                  : !cameraOn
                    ? "Main camera is off — the PiP feed already fills the stage"
                    : swapped
                      ? "Camera back to full stage, PiP feed to the corner"
                      : "PiP feed to full stage, camera to the corner"
              }
              onClick={toggleSwap}
            >
              <SwapIcon />
              {swapped ? "Camera full" : "PiP full"}
            </button>
            <button
              type="button"
              className="btn btn--overlay"
              aria-pressed={previewFullscreen}
              title="Fullscreen preview on this screen (does not change the stream)"
              onClick={() => void togglePreviewFullscreen()}
            >
              <FullscreenIcon exit={previewFullscreen} />
              {previewFullscreen ? "Exit" : "Fullscreen"}
            </button>
          </div>
          <div className="preview-caption">
            Live composition preview — students see this picture (
            {pipSource === "off" || !cameraOn
              ? "main stage"
              : swapped
                ? `${pipSourceLabel(pipSource)} full, camera PiP`
                : `camera full, ${pipSourceLabel(pipSource)} PiP`}
            ) plus your mixed audio.
          </div>
        </div>

        <div className="go-live-panel">
          <button
            type="button"
            className={`btn btn--xl ${live ? "btn--danger" : "btn--primary"}`}
            disabled={busy}
            onClick={() => void (live ? endClass() : startClass())}
          >
            {busy ? "Please wait…" : live ? "End class" : "Start class"}
          </button>

          <p className="hint">
            Video is composed in your browser (camera + optional PiP). Audio channels mix into{" "}
            <strong>one</strong> track for Cloudflare Stream (WHIP).
          </p>

          <div className="share-row">
            <label className="field">
              <span>Share this viewer link</span>
              <input readOnly value={viewerLink} />
            </label>
            <button type="button" className="btn btn--secondary" onClick={() => void copyViewerLink()}>
              Copy link
            </button>
          </div>

          {session?.liveInputUid ? (
            <p className="meta-line">
              Live input: <code>{session.liveInputUid}</code>
            </p>
          ) : (
            <p className="meta-line">
              No live input configured yet. Create one below, then put its UID in{" "}
              <code>STREAM_LIVE_INPUT_UID</code> so viewers stay in sync after restart.
            </p>
          )}

          {!session?.liveInputUid || session.needsLiveInput ? (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => void createInput()}
            >
              Create Cloudflare live input
            </button>
          ) : null}

          {error ? <p className="error-banner">{error}</p> : null}
        </div>
      </section>

      <section className="studio-section sources-board" aria-label="Live sources">
        <div className="section-head">
          <div>
            <h2>Live sources</h2>
            <p>
              Flip any feed on or off. Changes apply instantly to the preview and, when live, to
              what students receive.
            </p>
          </div>
          <span
            className={`source-pill source-pill--${roomStatus === "open" ? "ok" : "warn"} room-presence`}
          >
            {roomStatus === "open"
              ? `${roomState.viewerCount} student${roomState.viewerCount === 1 ? "" : "s"} connected`
              : roomStatus === "connecting"
                ? "Connecting talk-back relay…"
                : "Talk-back relay offline"}
          </span>
        </div>

        <div className="sources-grid">
          <div className="sources-column">
            <div className="sources-column__head">
              <h3>Visual feeds</h3>
              <button
                type="button"
                className={`btn btn--secondary btn--small btn--icon${swapped ? " is-active" : ""}`}
                disabled={pipSource === "off" || !cameraOn}
                aria-pressed={swapped}
                onClick={toggleSwap}
              >
                <SwapIcon />
                {swapped ? "Swap → camera full" : "Swap → PiP full"}
              </button>
            </div>
            <ul className="source-list">
              <SourceRow
                title="Main camera"
                subtitle={cameraOn ? cameraLabel : "Off — PiP feed fills the stage, or a “Camera off” card"}
                on={cameraOn}
                onToggle={(on) => void toggleCamera(on)}
                disabled={busy}
                badge={cameraOn ? (swapped && pipSource !== "off" ? "PiP" : "Stage") : undefined}
              />
              <SourceRow
                title="Slideshow"
                subtitle={
                  slideMeta
                    ? `Slide ${slideMeta.index + 1} / ${slideMeta.total} · ${slideMeta.name}`
                    : "Upload slides in section 2 to enable"
                }
                on={pipSource === "slideshow"}
                disabled={!slideMeta || busy}
                onToggle={(on) => void applyPipSource(on ? "slideshow" : "off")}
                badge={pipSource === "slideshow" ? pipBadge : undefined}
              >
                {slideMeta && pipSource === "slideshow" ? (
                  <div className="source-row__actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      disabled={slideMeta.index <= 0}
                      onClick={() => stepSlide(-1)}
                    >
                      Previous slide
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      disabled={slideMeta.index >= slideMeta.total - 1}
                      onClick={() => stepSlide(1)}
                    >
                      Next slide
                    </button>
                  </div>
                ) : null}
              </SourceRow>
              <SourceRow
                title="Second camera"
                subtitle={
                  secondaryCameras.length === 0
                    ? "No other camera detected"
                    : secondaryCameraLabel || "Second camera"
                }
                on={pipSource === "camera"}
                disabled={secondaryCameras.length === 0 || busy}
                onToggle={(on) => void applyPipSource(on ? "camera" : "off")}
                badge={pipSource === "camera" ? pipBadge : undefined}
              />
              <SourceRow
                title="Screen share"
                subtitle={
                  pipSource === "screen" && secondaryLabel
                    ? secondaryLabel
                    : "Share a window or browser tab"
                }
                on={pipSource === "screen"}
                disabled={busy}
                onToggle={(on) => void applyPipSource(on ? "screen" : "off")}
                badge={pipSource === "screen" ? pipBadge : undefined}
              />
            </ul>
          </div>

          <div className="sources-column">
            <h3>Audio channels</h3>
            <ul className="source-list">
              {deviceChannels.length === 0 ? (
                <li className="empty-hint">No microphones yet — add one in section 3.</li>
              ) : (
                deviceChannels.map((channel) => (
                  <SourceRow
                    key={channel.id}
                    title={channel.label}
                    subtitle={`${Math.round(channel.volume * 100)}% volume${channel.solo ? " · solo" : ""}`}
                    on={!channel.muted}
                    level={levels[channel.id] ?? 0}
                    onToggle={(on) => {
                      mixerRef.current?.setMuted(channel.id, !on);
                      syncChannelState();
                    }}
                    badge={channel.solo ? "Solo" : undefined}
                    onText="Live"
                    offText="Muted"
                  />
                ))
              )}
              <SourceRow
                title="Student talk-back"
                subtitle={
                  roomState.talkbackEnabled
                    ? talkers.length > 0
                      ? `${talkers.map((t) => t.name).join(", ")} talking`
                      : "Students can hold Talk on /watch to ask a question"
                    : "Students’ Talk button is disabled"
                }
                on={roomState.talkbackEnabled}
                onToggle={setTalkbackAllowed}
                disabled={roomStatus !== "open"}
                level={levels[TALKBACK_CHANNEL_ID] ?? 0}
                badge={talkers.length > 0 ? "Talking" : undefined}
                badgeTone="ok"
                onText="Allowed"
                offText="Off"
              >
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={talkbackMonitor}
                    onChange={(e) => applyTalkbackMonitor(e.target.checked)}
                  />
                  <span>Hear students on my speakers / headphones</span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={talkbackInMix}
                    onChange={(e) => applyTalkbackInMix(e.target.checked)}
                  />
                  <span>Also send student voices into the live mix (all viewers hear them)</span>
                </label>
              </SourceRow>
            </ul>
          </div>
        </div>
      </section>

      <section className="studio-section" aria-label="Main camera">
        <h2>1. Main camera</h2>
        <label className="field">
          <span>Which camera fills the stage?</span>
          <select
            value={cameraId}
            onChange={(e) => {
              void attachCamera(e.target.value).catch((err) => {
                setError(
                  err instanceof Error ? err.message : "Could not open that camera",
                );
              });
            }}
            disabled={live}
          >
            {cameras.map((cam) => (
              <option key={cam.deviceId} value={cam.deviceId}>
                {cam.label || "Camera"}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="studio-section" aria-label="Picture-in-picture">
        <div className="section-head">
          <div>
            <h2>2. Picture-in-picture</h2>
            <p>
              Overlay a slideshow, second camera, or screen share on the composed stream viewers
              receive.
            </p>
          </div>
        </div>

        <div className="pip-source-row" role="group" aria-label="PiP source">
          {(
            [
              ["off", "Off"],
              ["slideshow", "Slideshow"],
              ["camera", "2nd camera"],
              ["screen", "Screen share"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`btn btn--toggle${pipSource === id ? " is-active" : ""}`}
              onClick={() => void applyPipSource(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="pip-layout-row">
          <label className="field">
            <span>PiP position</span>
            <select
              value={pipCorner}
              onChange={(e) => {
                const corner = e.target.value as PipCorner;
                setPipCorner(corner);
                applyPipLayout(corner, pipSize);
              }}
            >
              {CORNER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>PiP size</span>
            <select
              value={pipSize}
              onChange={(e) => {
                const size = e.target.value as PipSize;
                setPipSize(size);
                applyPipLayout(pipCorner, size);
              }}
            >
              {SIZE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="pip-panel">
          <h3>Slideshow</h3>
          <p className="hint">
            Upload a PDF or a set of images (PNG, JPEG, WebP…). Step through slides while live.
          </p>
          <div className="pip-actions">
            <input
              ref={slideInputRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp,.pdf"
              multiple
              hidden
              onChange={(e) => void onSlidesSelected(e.target.files)}
            />
            <button
              type="button"
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => slideInputRef.current?.click()}
            >
              Upload slides
            </button>
            {slideMeta ? (
              <button type="button" className="btn btn--ghost" onClick={clearSlideshow}>
                Clear slides
              </button>
            ) : null}
          </div>
          {slideMeta ? (
            <div className="slide-controls">
              <button
                type="button"
                className="btn btn--secondary"
                disabled={slideMeta.index <= 0}
                onClick={() => stepSlide(-1)}
              >
                Previous
              </button>
              <p className="slide-status">
                Slide {slideMeta.index + 1} / {slideMeta.total}
                <span className="slide-status__name">{slideMeta.name}</span>
              </p>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={slideMeta.index >= slideMeta.total - 1}
                onClick={() => stepSlide(1)}
              >
                Next
              </button>
            </div>
          ) : (
            <p className="empty-hint">No slideshow loaded yet.</p>
          )}
        </div>

        <div className="pip-panel">
          <h3>Second visual</h3>
          <p className="hint">
            Use another camera or share a window/tab. Choose <strong>2nd camera</strong> or{" "}
            <strong>Screen share</strong> above to put it in PiP.
          </p>
          <label className="field">
            <span>Second camera</span>
            <select
              value={secondaryCameraId}
              onChange={(e) => {
                setSecondaryCameraId(e.target.value);
                if (pipSource === "camera") {
                  void applyPipSource("camera");
                }
              }}
            >
              {secondaryCameras.length === 0 ? (
                <option value="">No other camera detected</option>
              ) : (
                secondaryCameras.map((cam) => (
                  <option key={cam.deviceId} value={cam.deviceId}>
                    {cam.label || "Camera"}
                  </option>
                ))
              )}
            </select>
          </label>
          {secondaryLabel && pipSource !== "off" && pipSource !== "slideshow" ? (
            <p className="meta-line">Active PiP visual: {secondaryLabel}</p>
          ) : null}
        </div>
      </section>

      <section className="studio-section" aria-label="Audio channels">
        <div className="section-head">
          <div>
            <h2>3. Audio channels</h2>
            <p>
              Add instructor mic, room mic, laptop audio, or extras. Each has Mute, Solo, and Volume.
            </p>
          </div>
          <div className="mix-meter">
            <span>Outgoing mix</span>
            <LevelMeter level={levels.__mix__ ?? 0} />
          </div>
        </div>

        <div className="add-channel">
          <label className="field">
            <span>Role</span>
            <select value={addRole} onChange={(e) => setAddRole(e.target.value)} disabled={live}>
              {ROLE_PRESETS.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Device</span>
            <select
              value={addDeviceId}
              onChange={(e) => setAddDeviceId(e.target.value)}
              disabled={live}
            >
              {mics.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label || "Microphone"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={live || !addDeviceId}
            onClick={() => void addAudioChannel()}
          >
            Add channel
          </button>
        </div>

        <div className="channel-grid">
          {deviceChannels.length === 0 ? (
            <p className="empty-hint">No microphones yet. Add at least one before Start class.</p>
          ) : (
            deviceChannels.map((channel) => (
              <AudioChannelCard
                key={channel.id}
                label={channel.label}
                deviceLabel={channel.deviceId.slice(0, 8) + "…"}
                muted={channel.muted}
                solo={channel.solo}
                volume={channel.volume}
                level={levels[channel.id] ?? 0}
                onMuteToggle={() => {
                  mixerRef.current?.setMuted(channel.id, !channel.muted);
                  syncChannelState();
                }}
                onSoloToggle={() => {
                  mixerRef.current?.setSolo(channel.id, !channel.solo);
                  syncChannelState();
                }}
                onVolumeChange={(value) => {
                  mixerRef.current?.setVolume(channel.id, value);
                  syncChannelState();
                }}
                onRemove={() => {
                  if (live) return;
                  mixerRef.current?.remove(channel.id);
                  syncChannelState();
                }}
              />
            ))
          )}
        </div>
      </section>
    </main>
  );
}
