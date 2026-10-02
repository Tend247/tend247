// Small, dependency-free charts for the dashboard. Marks follow one spec: 2px lines, bars at
// most 24px thick with a 4px rounded end, hairline recessive grid, text in text colours (never
// the series colour), a legend for two or more series, and a hover/focus readout. Every value
// is also available in a table view.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/** The rendered width of an element, so SVG text stays at its real size instead of scaling. */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export interface Series {
  key: string;
  label: string;
  /** CSS variable holding the series colour, e.g. var(--series-1). */
  color: string;
  values: number[];
}

function niceMax(max: number): number {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}

const fmt = (n: number) => n.toLocaleString();
const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** Lines over days, with a crosshair that snaps to the nearest day and lists every series. */
export function LineChart({ days, series, height = 220, title }: { days: string[]; series: Series[]; height?: number; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { ref: frameRef, width } = useWidth<HTMLDivElement>(640);
  const pad = { top: 12, right: 64, bottom: 26, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const x = (i: number) => pad.left + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(days.length / Math.max(2, Math.floor(plotW / 90)));

  function onMove(e: PointerEvent<SVGRectElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - pad.left) / plotW) * (days.length - 1));
    setHover(Math.min(days.length - 1, Math.max(0, i)));
  }
  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === "ArrowRight") setHover((h) => Math.min(days.length - 1, (h ?? -1) + 1));
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? days.length) - 1));
    if (e.key === "Escape") setHover(null);
  }
  // End labels: skip when two series end within 14px of each other (the legend carries them).
  const ends = series.map((s) => ({ s, y: y(s.values.at(-1) ?? 0) }));
  const crowded = ends.length > 1 && Math.abs(ends[0]!.y - ends[1]!.y) < 14;

  return (
    <div className="chart">
      <div className="legend" aria-hidden="true">
        {series.map((s) => (
          <span key={s.key} className="legend-item">
            <span className="key-line" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="chart-frame" ref={frameRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          className="chart-svg"
          role="img"
          aria-label={`${title}. Use the left and right arrow keys to read each day.`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={pad.left - 8} y={y(t) + 4} className="tick" textAnchor="end">
                {fmt(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            i % labelEvery === 0 || i === days.length - 1 ? (
              <text key={d} x={x(i)} y={height - 6} className="tick" textAnchor="middle">
                {shortDay(d)}
              </text>
            ) : null,
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} className="crosshair" />}
          {series.map((s) => (
            <g key={s.key}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              />
              <circle cx={x(s.values.length - 1)} cy={y(s.values.at(-1) ?? 0)} r={4} fill={s.color} className="ring" />
              {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4.5} fill={s.color} className="ring" />}
            </g>
          ))}
          {!crowded &&
            ends.map(({ s, y: ey }) => (
              <text key={s.key} x={width - pad.right + 10} y={ey + 4} className="end-label">
                {s.label} {fmt(s.values.at(-1) ?? 0)}
              </text>
            ))}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null && (
          <div className="tooltip" style={{ left: `${(x(hover) / width) * 100}%` }} role="status">
            <div className="tooltip-title">{shortDay(days[hover]!)}</div>
            {series.map((s) => (
              <div key={s.key} className="tooltip-row">
                <span className="key-line" style={{ background: s.color }} />
                <strong>{fmt(s.values[hover] ?? 0)}</strong>
                <span className="muted">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Horizontal bars for a few labelled values (one series), value at the bar tip. */
export function BarList({ items, color = "var(--series-1)", label }: { items: { label: string; value: number }[]; color?: string; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const id = useId();
  return (
    <ul className="barlist" aria-label={label}>
      {items.map((item, i) => (
        <li key={item.label} tabIndex={0} title={`${item.label}: ${fmt(item.value)}`} aria-describedby={`${id}-${i}`}>
          <span className="barlist-label">{item.label}</span>
          <span className="barlist-track">
            <span className="barlist-bar" style={{ width: `${(item.value / max) * 100}%`, background: color }} />
            <span className="barlist-value" id={`${id}-${i}`}>
              {fmt(item.value)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A number with a label, optionally with a status icon so colour never carries meaning alone. */
export function StatTile({ label, value, note, status, hero }: { label: string; value: string; note?: string; status?: "critical" | "good"; hero?: boolean }) {
  return (
    <div className={`stat ${hero ? "hero-stat" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {status && (
          <span className={`status-icon ${status}`} aria-hidden="true">
            {status === "critical" ? "!" : "✓"}
          </span>
        )}
        {value}
      </div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}
