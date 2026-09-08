import { LevelMeter } from "./LevelMeter";

interface AudioChannelCardProps {
  label: string;
  deviceLabel: string;
  muted: boolean;
  solo: boolean;
  volume: number;
  level: number;
  onMuteToggle: () => void;
  onSoloToggle: () => void;
  onVolumeChange: (value: number) => void;
  onRemove: () => void;
}

export function AudioChannelCard({
  label,
  deviceLabel,
  muted,
  solo,
  volume,
  level,
  onMuteToggle,
  onSoloToggle,
  onVolumeChange,
  onRemove,
}: AudioChannelCardProps) {
  return (
    <article className={`channel-card${muted ? " is-muted" : ""}${solo ? " is-solo" : ""}`}>
      <header className="channel-card__head">
        <div>
          <h3>{label}</h3>
          <p>{deviceLabel}</p>
        </div>
        <button type="button" className="btn btn--ghost btn--small" onClick={onRemove}>
          Remove
        </button>
      </header>

      <LevelMeter level={muted ? 0 : level} label="Channel level" />

      <div className="channel-card__controls">
        <button
          type="button"
          className={`btn btn--toggle${muted ? " is-active-danger" : ""}`}
          onClick={onMuteToggle}
          aria-pressed={muted}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <button
          type="button"
          className={`btn btn--toggle${solo ? " is-active" : ""}`}
          onClick={onSoloToggle}
          aria-pressed={solo}
        >
          Solo
        </button>
      </div>

      <label className="volume-slider">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
        />
        <strong>{Math.round(volume * 100)}%</strong>
      </label>
    </article>
  );
}
