import type { CSSProperties } from "react";

interface LevelMeterProps {
  level: number;
  label?: string;
}

export function LevelMeter({ level, label }: LevelMeterProps) {
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100);
  const style = { "--level": `${pct}%` } as CSSProperties;

  return (
    <div className="level-meter" style={style} aria-label={label ?? "Audio level"}>
      <div className="level-meter__track">
        <div className="level-meter__fill" />
      </div>
      {label ? <span className="level-meter__label">{label}</span> : null}
    </div>
  );
}
