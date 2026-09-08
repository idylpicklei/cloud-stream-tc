interface ToggleSwitchProps {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  onText?: string;
  offText?: string;
  tone?: "accent" | "danger";
}

export function ToggleSwitch({
  on,
  onChange,
  disabled,
  label,
  onText = "On",
  offText = "Off",
  tone = "accent",
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`toggle-switch toggle-switch--${tone}${on ? " is-on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-switch__track" aria-hidden="true">
        <span className="toggle-switch__thumb" />
      </span>
      <span className="toggle-switch__text">{on ? onText : offText}</span>
    </button>
  );
}
