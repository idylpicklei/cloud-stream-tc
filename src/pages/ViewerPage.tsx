import { useEffect, useRef, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { StatusBadge } from "../components/StatusBadge";
import { fetchViewerConfig, type ViewerConfig } from "../lib/api";
import { startWhepPlayback, stopWhepPlayback, type WhepSession } from "../lib/whep";

type PlayMode = "player" | "whep";

export function ViewerPage() {
  const [config, setConfig] = useState<ViewerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PlayMode>("whep");
  const [watching, setWatching] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const whepRef = useRef<WhepSession | null>(null);

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
        // Prefer Stream player when customer code exists; WHEP always works for WHIP live.
        setMode(data.playerUrl ? "player" : "whep");
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

  const live = (config?.status ?? "").toLowerCase().includes("connected") || watching;

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
              title="Training Center player"
              src={`${config.playerUrl}?autoplay=true&muted=true`}
              allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
        ) : (
          <div className="player-frame player-frame--native">
            <video ref={videoRef} autoPlay playsInline controls />
          </div>
        )}

        <div className="viewer-actions">
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

          {mode === "whep" ? (
            <button
              type="button"
              className={`btn btn--xl ${watching ? "btn--danger" : "btn--primary"}`}
              onClick={() => void (watching ? stopWatching() : watchWhep())}
            >
              {watching ? "Stop watching" : "Watch"}
            </button>
          ) : (
            <p className="hint">
              Stream player loads automatically. If the class is not live yet, you will see a waiting
              message.
            </p>
          )}

          {error ? <p className="error-banner">{error}</p> : null}
          {config?.note ? <p className="hint">{config.note}</p> : null}
        </div>
      </section>
    </main>
  );
}
