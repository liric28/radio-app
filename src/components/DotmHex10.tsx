"use client";

import { useState, useEffect, useRef, type CSSProperties } from "react";

const ROW_COUNTS = [3, 4, 5, 4, 3] as const;
const BASE_OPACITY = 0.09;
const HIGH_OPACITY = 0.98;
const HEX_ROW_PITCH_RATIO = Math.sqrt(3) / 2;

function hexPatternIndex(row: number, rowCount: number, col: number): number {
  return row * ROW_COUNTS[2] + Math.floor((ROW_COUNTS[2] - rowCount) / 2) + col;
}

function clamp01(n: number | undefined) {
  if (n == null || !Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

function pointForCell(row: number, col: number) {
  const count = ROW_COUNTS[row] ?? 1;
  const x = col - (count - 1) / 2;
  const y = (row - 2) * HEX_ROW_PITCH_RATIO;
  return { x, y, angle: Math.atan2(y, x), radius: Math.sqrt(x * x + y * y) };
}

function ripple(value: number, width: number): number {
  const wrapped = ((value % 1) + 1) % 1;
  const distance = Math.min(wrapped, 1 - wrapped);
  return Math.max(0, 1 - distance / width);
}

function opacityForCell(row: number, col: number, phase: number): number {
  const { x, y, radius } = pointForCell(row, col);
  const lensCenter = Math.sin(phase * Math.PI * 2) * 1.15;
  const lensDistance = Math.abs(lensCenter - x * 0.88 - y * 0.16);
  const liquidLens = Math.max(0, 1 - lensDistance / 0.78);

  const wakeFront = ripple(phase + x * 0.12 - y * 0.045 + radius * 0.07, 0.16);
  const wakeBack = ripple(phase + 0.34 + x * 0.09 + y * 0.035 + radius * 0.05, 0.2) * 0.34;
  const verticalCompression =
    Math.max(0, 1 - Math.abs(Math.cos(phase * Math.PI * 2) * 1.18 - y * 1.25) / 1.1) * 0.18;
  const shellSheen =
    (0.5 + 0.5 * Math.sin(phase * Math.PI * 2 - radius * 1.9)) * (radius > 1.35 ? 0.16 : 0.06);
  const core = radius < 0.1 ? 0.34 + Math.sin(phase * Math.PI * 2) * 0.1 : 0;

  return Math.min(
    HIGH_OPACITY,
    BASE_OPACITY + liquidLens * 0.72 + wakeFront * 0.38 + wakeBack + verticalCompression + shellSheen + core
  );
}

function stylePx(n: number) { return `${n}px`; }

type DotMatrixCommonProps = {
  size?: number;
  dotSize?: number;
  color?: string;
  ariaLabel?: string;
  className?: string;
  muted?: boolean;
  bloom?: boolean;
  halo?: number;
  dotClassName?: string;
  dotShape?: "circle" | "square";
  speed?: number;
  animated?: boolean;
  hoverAnimated?: boolean;
  pattern?: string;
  cellPadding?: number;
  boxSize?: number;
  minSize?: number;
  opacityBase?: number;
  opacityMid?: number;
  opacityPeak?: number;
};

export function DotmHex10({
  size = 34,
  dotSize = 5,
  color = "#54d88c",
  ariaLabel = "Loading",
  className,
  muted = false,
  bloom = false,
  halo = 0,
  dotClassName,
  dotShape = "circle",
  speed = 1.55,
  animated = true,
  pattern = "full",
  cellPadding,
  boxSize,
  minSize,
  opacityBase,
  opacityMid,
  opacityPeak
}: DotMatrixCommonProps) {
  const ob = clamp01(opacityBase);
  const om = clamp01(opacityMid);
  const op = clamp01(opacityPeak);

  const [phase, setPhase] = useState(0.14);
  const phaseRef = useRef(0.14);

  useEffect(() => {
    if (!animated) return;
    let last = 0;
    let raf: number;
    const step = (ts: number) => {
      if (last === 0) last = ts;
      const delta = ts - last;
      last = ts;
      phaseRef.current = (phaseRef.current + delta * speed / 45000) % 1;
      setPhase(phaseRef.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [animated, speed]);

  const gap =
    cellPadding ?? Math.max(1, Math.floor((size - dotSize * ROW_COUNTS[2]) / (ROW_COUNTS[2] - 1)));
  const rowGap = Math.max(1, (dotSize + gap) * HEX_ROW_PITCH_RATIO - dotSize);
  const matrixWidth = dotSize * ROW_COUNTS[2] + gap * (ROW_COUNTS[2] - 1);
  const matrixHeight = dotSize * ROW_COUNTS.length + rowGap * (ROW_COUNTS.length - 1);
  const matrixSpan = Math.max(matrixWidth, matrixHeight);
  const outerDim = Math.max(boxSize ?? matrixSpan, minSize ?? 0);
  const useWrapper = boxSize != null || minSize != null;
  const scale = useWrapper && matrixSpan > 0 ? outerDim / matrixSpan : 1;

  const getPatternIndexes = (p: string): number[] => {
    if (p === "full") {
      return Array.from(
        { length: ROW_COUNTS[2] * ROW_COUNTS.length },
        (_, i) => i
      );
    }
    if (p === "center") return [ROW_COUNTS[2] * 2 + 2];
    return [];
  };

  const activePatternIndexes = getPatternIndexes(pattern);

  const dmxDotBloomParts = (
    isActive: boolean,
    opacity: number,
    bloom: boolean
  ) => {
    if (!isActive || !bloom) return { bloomDot: false, level: 0 };
    const level = Math.floor(opacity * 3) + 1;
    return { bloomDot: level > 0, level };
  };

  const matrixStyle: CSSProperties = {
    width: stylePx(matrixWidth),
    height: stylePx(matrixHeight),
    color,
    ["--dmx-dot-size" as string]: `${dotSize}px`,
  };

  const rootClass = [
    "dmx-root",
    `dmx-dot-shape-${dotShape}`,
    muted && "dmx-muted",
    bloom && "dmx-bloom",
  ].filter(Boolean).join(" ");

  const renderDot = (row: number, count: number, col: number) => {
    const idx = hexPatternIndex(row, count, col);
    const isActive = activePatternIndexes.includes(idx);
    const opacity = isActive ? opacityForCell(row, col, phase) : 0;
    const dmxBloom = dmxDotBloomParts(isActive, opacity, bloom);
    const opacityVal = opacity;

    return (
      <span
        key={`${row},${col}`}
        aria-hidden="true"
        className={[
          "dmx-dot",
          !isActive && "dmx-inactive",
          dmxBloom.bloomDot && "dmx-bloom-dot",
          dotClassName,
        ].filter(Boolean).join(" ")}
        style={{
          width: stylePx(dotSize),
          height: stylePx(dotSize),
          opacity: opacityVal,
          backgroundColor: isActive ? color : "transparent",
          borderRadius: dotShape === "circle" ? "50%" : "2px",
          ["--dmx-bloom-level" as string]: dmxBloom.level,
        } as CSSProperties}
      />
    );
  };

  const matrix = (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={rootClass}
      style={matrixStyle}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: stylePx(rowGap),
          width: "100%",
          height: "100%",
        }}
      >
        {ROW_COUNTS.map((count, row) => (
          <div
            key={row}
            style={{ display: "flex", justifyContent: "center", gap: stylePx(gap) }}
          >
            {Array.from({ length: count }).map((_, col) =>
              renderDot(row, count, col)
            )}
          </div>
        ))}
      </div>
    </div>
  );

  if (useWrapper) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={ariaLabel}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: stylePx(outerDim),
          height: stylePx(outerDim),
          minWidth: minSize != null ? stylePx(minSize) : undefined,
          minHeight: minSize != null ? stylePx(minSize) : undefined,
          overflow: "hidden",
          transform: scale !== 1 ? `scale(${scale})` : undefined,
          transformOrigin: "center center",
        }}
      >
        {matrix}
      </div>
    );
  }

  return matrix;
}
