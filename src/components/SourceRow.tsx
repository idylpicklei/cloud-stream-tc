import type { ReactNode } from "react";
import { LevelMeter } from "./LevelMeter";
import { ToggleSwitch } from "./ToggleSwitch";

interface SourceRowProps {
  title: string;
  subtitle?: ReactNode;
  on: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  /** Optional live level (0..1) for audio sources. */
  level?: number;
  /** Small status pill, e.g. "Live", "Full stage", "Talking". */
  badge?: string;
  badgeTone?: "accent" | "ok" | "warn";
  onText?: string;
  offText?: string;
  children?: ReactNode;
}

export function SourceRow({
  title,
  subtitle,
  on,
  onToggle,
  disabled,
  level,
  badge,
  badgeTone = "accent",
  onText,
  offText,
  children,
}: SourceRowProps) {
  return (
    <li className={`source-row${on ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}>
      <div className="source-row__main">
        <div className="source-row__text">
          <div className="source-row__title">
            <span>{title}</span>
            {badge ? <span className={`source-pill source-pill--${badgeTone}`}>{badge}</span> : null}
          </div>
          {subtitle ? <p className="source-row__subtitle">{subtitle}</p> : null}
          {level !== undefined ? <LevelMeter level={on ? level : 0} /> : null}
        </div>
        <ToggleSwitch
          on={on}
          onChange={onToggle}
          disabled={disabled}
          label={`${title} ${on ? "on" : "off"}`}
          onText={onText}
          offText={offText}
        />
      </div>
      {children ? <div className="source-row__extra">{children}</div> : null}
    </li>
  );
}
