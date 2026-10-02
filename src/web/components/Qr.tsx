import qrcode from "qrcode-generator";

/** A QR code drawn as SVG (one path; scales crisply). */
export function Qr({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 4;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  }
  const total = n + margin * 2;
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${total} ${total}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
