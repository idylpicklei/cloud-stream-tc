import { useEffect, useMemo, useRef, useState } from "react";
import { AudioChannelCard } from "../components/AudioChannelCard";
import { LevelMeter } from "../components/LevelMeter";
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
import { startWhipBroadcast, stopWhipBroadcast, type WhipSession } from "../lib/whip";

const TOKEN_KEY = "classstream-host-token";

const ROLE_PRESETS = [
  { id: "teacher", label: "Teacher mic" },
  { id: "room", label: "Room / classroom mic" },
  { id: "laptop", label: "Laptop / system audio" },
  { id: "extra", label: "Extra input" },
] as const;

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

  const previewRef = useRef<HTMLVideoElement>(null);
  const mixerRef = useRef<AudioMixer | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const whipRef = useRef<WhipSession | null>(null);

  const viewerLink = useMemo(() => {
    if (typeof window === "undefined") return "/watch";
    return `${window.location.origin}/watch`;
  }, []);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    return () => {
      void stopWhipBroadcast(whipRef.current);
      whipRef.current = null;
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      mixerRef.current?.dispose();
    };
  }, []);

  async function unlockStudio() {
    setError(null);
    setBusy(true);
    try {
      localStorage.setItem(TOKEN_KEY, token.trim());
      await pingHost(token.trim());
      const hostSession = await fetchHostSession(token.trim());
      setSession(hostSession);
      // Auth succeeded — stay in studio even if camera/mic setup fails next.
      setUnlocked(true);
      if (hostSession.needsLiveInput && hostSession.message) {
        setError(hostSession.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock host studio");
      setUnlocked(false);
      setBusy(false);
      return;
    }

    // Device / permission errors must not bounce back to the password gate.
    await setupDevices();
    setBusy(false);
  }

  async function ensureMixer() {
    if (mixerRef.current) return;
    try {
      const mixer = new AudioMixer();
      mixerRef.current = mixer;
      mixer.onLevels(setLevels);
    } catch {
      // AudioContext unavailable — rare (locked-down browser)
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

      if (videoDevices[0]) {
        await attachCamera(videoDevices[0].deviceId);
      } else {
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
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
      }
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
      const created = await createLiveInput(token.trim(), "ClassStream classroom");
      setSession(created);
      if (created.message) setError(created.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create live input");
    } finally {
      setBusy(false);
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

      if (mixer.list().length === 0) {
        throw new Error("Add at least one microphone before going live.");
      }
      if (!cameraStreamRef.current) {
        throw new Error("Turn on your camera before going live.");
      }

      const videoTrack = cameraStreamRef.current.getVideoTracks()[0];
      const audioTrack = mixer.mixedAudioTrack;
      if (!videoTrack || !audioTrack) {
        throw new Error("Camera or mixed audio track is missing.");
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
      // Keep camera + mixer running so the instructor can go live again quickly.
      if (previewRef.current && cameraStreamRef.current) {
        previewRef.current.srcObject = cameraStreamRef.current;
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
          <p className="eyebrow">Host studio</p>
          <h1>ClassStream</h1>
          <p className="lede">
            Enter the shared host password to set up cameras and microphones, then start class.
          </p>

          <label className="field">
            <span>Host password</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="HOST_TOKEN from your .dev.vars"
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
        <div>
          <p className="eyebrow">Host studio</p>
          <h1>ClassStream</h1>
          <p className="lede">
            Pick your camera, add microphones, check the mix, then press Start Class.
          </p>
        </div>
        <StatusBadge live={live} />
      </header>

      <section className="studio-hero" aria-label="Camera and go-live controls">
        <div className="preview-shell">
          <video ref={previewRef} className="camera-preview" autoPlay muted playsInline />
          <div className="preview-caption">
            You are looking at your camera preview. Students see this plus your mixed audio.
          </div>
        </div>

        <div className="go-live-panel">
          <button
            type="button"
            className={`btn btn--xl ${live ? "btn--danger" : "btn--primary"}`}
            disabled={busy}
            onClick={() => void (live ? endClass() : startClass())}
          >
            {busy ? "Please wait…" : live ? "End Class" : "Start Class"}
          </button>

          <p className="hint">
            Audio channels are mixed in your browser into <strong>one</strong> stream for Cloudflare
            Stream (WHIP). Mute / Solo / Volume only affect that mix.
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

      <section className="studio-section" aria-label="Camera">
        <h2>1. Camera</h2>
        <label className="field">
          <span>Which camera?</span>
          <select
            value={cameraId}
            onChange={(e) => {
              void attachCamera(e.target.value).catch((err) => {
                setError(
                  err instanceof Error
                    ? err.message
                    : "Could not open that camera",
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

      <section className="studio-section" aria-label="Audio channels">
        <div className="section-head">
          <div>
            <h2>2. Audio channels</h2>
            <p>Add teacher mic, room mic, laptop audio, or extras. Each has Mute, Solo, and Volume.</p>
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
          {channels.length === 0 ? (
            <p className="empty-hint">No microphones yet. Add at least one before Start Class.</p>
          ) : (
            channels.map((channel) => (
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
