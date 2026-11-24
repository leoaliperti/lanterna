import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";

export interface GridPreviewProps {
  /** Immagine della mappa (URL o anteprima locale del file scelto). */
  src: string;
  /** Lato della cella in pixel dell'immagine. */
  cellSize: number | null;
  offsetX: number;
  offsetY: number;
  color: string;
  opacity: number;
  /** Modalità calibrazione: il clic su due punti misura la distanza di riferimento. */
  calibrating: boolean;
  /** Punti scelti (pixel dell'immagine); il genitore li tiene per poter calcolare la cella. */
  points: readonly Point[];
  onPointsChange: (points: Point[]) => void;
  alt: string;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Anteprima della mappa con la griglia sovrapposta (stessi valori che la scena userà). In
 * calibrazione i clic scelgono due punti di riferimento: la distanza fra loro, in pixel, serve a
 * calcolare la dimensione della cella dalla distanza reale (vedi `cellFromCalibration`).
 */
export function GridPreview({ src, cellSize, offsetX, offsetY, color, opacity, calibrating, points, onPointsChange, alt }: GridPreviewProps) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const patternId = useId().replace(/:/g, "");

  // Immagini nuove: si riparte dalle dimensioni reali.
  useEffect(() => setNatural(null), [src]);

  const pattern = useMemo(() => {
    if (!cellSize || cellSize <= 0) return null;
    return (
      <pattern id={patternId} width={cellSize} height={cellSize} patternUnits="userSpaceOnUse" x={offsetX} y={offsetY}>
        <path d={`M ${cellSize} 0 L 0 0 0 ${cellSize}`} fill="none" stroke={color} strokeWidth={Math.max(1, cellSize / 40)} />
      </pattern>
    );
  }, [cellSize, offsetX, offsetY, color, patternId]);

  function onClick(e: MouseEvent<SVGSVGElement>) {
    if (!calibrating || !natural || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * natural.width;
    const y = ((e.clientY - rect.top) / rect.height) * natural.height;
    // Due punti: il terzo clic ricomincia da capo.
    onPointsChange(points.length >= 2 ? [{ x, y }] : [...points, { x, y }]);
  }

  return (
    <div className="a-gridpreview" data-calibrating={calibrating || undefined}>
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className="a-gridpreview__img"
        onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      />
      {natural ? (
        <svg
          ref={svgRef}
          className="a-gridpreview__svg"
          viewBox={`0 0 ${natural.width} ${natural.height}`}
          role="img"
          aria-label={`${alt}: anteprima della griglia${calibrating ? ", clicca due punti per misurare" : ""}`}
          onClick={onClick}
          style={{ cursor: calibrating ? "crosshair" : "default" }}
        >
          <defs>{pattern}</defs>
          {cellSize ? <rect x={0} y={0} width={natural.width} height={natural.height} fill={`url(#${patternId})`} opacity={opacity} /> : null}
          {points.length === 2 ? (
            <line x1={points[0]!.x} y1={points[0]!.y} x2={points[1]!.x} y2={points[1]!.y} stroke="#ffffff" strokeWidth={Math.max(2, natural.width / 400)} strokeDasharray="8 6" />
          ) : null}
          {points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={Math.max(6, natural.width / 150)} fill="#e03131" stroke="#ffffff" strokeWidth={2} />
          ))}
        </svg>
      ) : null}
    </div>
  );
}

/**
 * Dimensione della cella (pixel) dalla misura di riferimento: la distanza fra i due punti (px) vale
 * `realDistance` unità di gioco, e una cella vale `unitsPerCell` unità.
 * Esempio: 300 px = 30 piedi, cella = 5 piedi → 300 × 5 / 30 = 50 px.
 */
export function cellFromCalibration(a: Point, b: Point, realDistance: number, unitsPerCell: number): number | null {
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(px > 0) || !(realDistance > 0) || !(unitsPerCell > 0)) return null;
  return (px * unitsPerCell) / realDistance;
}
