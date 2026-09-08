interface BrandMarkProps {
  size?: "sm" | "md" | "lg" | "hero";
  subtitle?: string | null;
  as?: "h1" | "p" | "div";
}

export function BrandMark({
  size = "md",
  subtitle = "Live class stream",
  as: Tag = "div",
}: BrandMarkProps) {
  return (
    <Tag className={`brand-mark brand-mark--${size}`}>
      <span className="brand-mark__mark" aria-hidden="true">
        <span className="brand-mark__glyph" />
      </span>
      <span className="brand-mark__text">
        <span className="brand-mark__name">Training Center</span>
        {subtitle ? <span className="brand-mark__subtitle">{subtitle}</span> : null}
      </span>
    </Tag>
  );
}
