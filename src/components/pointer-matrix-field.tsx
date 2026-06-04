"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export interface PointerMatrixFieldHandle {
  setPointer: (x: number, y: number) => void;
  clearPointer: () => void;
}

interface PointerMatrixFieldProps {
  className?: string;
  theme: "light" | "dark";
}

type MatrixState = {
  width: number;
  height: number;
  dpr: number;
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  currentWarp: number;
  targetWarp: number;
  currentTint: number;
  targetTint: number;
  rafId: number | null;
};

const GRID_GAP = 18;
const BASE_RADIUS = 1.1;
const LENS_RADIUS = 128;
const LENS_MAX_SCALE = 1.42;
const LENS_MAX_ALPHA = 0.98;
const LENS_MAX_RADIUS = 1.9;
const IDLE_FADE_DELAY_MS = 70;
const IDLE_TINT_HOLD = 0.72;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function resizeCanvas(canvas: HTMLCanvasElement, state: MatrixState) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  state.width = width;
  state.height = height;
  state.dpr = dpr;
}

// 底层矩阵本身参与形变，越靠近鼠标中心权重越高。
function resolveLensWeight(distance: number) {
  const normalized = clamp01(1 - distance / LENS_RADIUS);
  return normalized * normalized * (3 - 2 * normalized);
}

export const PointerMatrixField = forwardRef<
  PointerMatrixFieldHandle,
  PointerMatrixFieldProps
>(function PointerMatrixField({ className, theme }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeRef = useRef(theme);
  const reducedMotionRef = useRef(false);
  const scheduleFrameRef = useRef<() => void>(() => {});
  const idleFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<MatrixState>({
    width: 0,
    height: 0,
    dpr: 1,
    currentX: 0,
    currentY: 0,
    targetX: 0,
    targetY: 0,
    currentWarp: 0,
    targetWarp: 0,
    currentTint: 0,
    targetTint: 0,
    rafId: null,
  });

  useEffect(() => {
    themeRef.current = theme;
    scheduleFrameRef.current();
  }, [theme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reducedMotionRef.current = mediaQuery.matches;
    };

    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  const drawFrame = () => {
    const canvas = canvasRef.current;
    const state = stateRef.current;
    if (!canvas) {
      state.rafId = null;
      return;
    }

    resizeCanvas(canvas, state);
    const context = canvas.getContext("2d");
    if (!context) {
      state.rafId = null;
      return;
    }

    const reducedMotion = reducedMotionRef.current;
    const positionEase = reducedMotion ? 1 : 0.24;
    const warpEase = reducedMotion ? 1 : 0.18;
    const tintEase = reducedMotion ? 1 : 0.14;

    state.currentX += (state.targetX - state.currentX) * positionEase;
    state.currentY += (state.targetY - state.currentY) * positionEase;
    state.currentWarp += (state.targetWarp - state.currentWarp) * warpEase;
    state.currentTint += (state.targetTint - state.currentTint) * tintEase;

    const width = state.width;
    const height = state.height;
    const dpr = state.dpr;
    const baseColor =
      themeRef.current === "light"
        ? { r: 88, g: 80, b: 128, a: 0.26 }
        : { r: 244, g: 243, b: 248, a: 0.22 };
    const lensColor =
      themeRef.current === "light"
        ? { r: 62, g: 201, b: 132, a: 0.94 }
        : { r: 84, g: 216, b: 140, a: 0.98 };

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    for (let y = GRID_GAP / 2; y < height; y += GRID_GAP) {
      for (let x = GRID_GAP / 2; x < width; x += GRID_GAP) {
        const dx = x - state.currentX;
        const dy = y - state.currentY;
        const distance = Math.hypot(dx, dy);
        const lensWeight = resolveLensWeight(distance);
        const warpWeight = lensWeight * state.currentWarp;
        const tintWeight = lensWeight * state.currentTint;
        const safeDistance = distance || 1;
        const scale = 1 + warpWeight * (LENS_MAX_SCALE - 1);
        const dotX = state.currentX + (dx / safeDistance) * (safeDistance * scale);
        const dotY = state.currentY + (dy / safeDistance) * (safeDistance * scale);
        const radius = mix(BASE_RADIUS, LENS_MAX_RADIUS, tintWeight);
        const alpha = mix(baseColor.a, LENS_MAX_ALPHA, tintWeight);
        const r = Math.round(mix(baseColor.r, lensColor.r, tintWeight));
        const g = Math.round(mix(baseColor.g, lensColor.g, tintWeight));
        const b = Math.round(mix(baseColor.b, lensColor.b, tintWeight));

        context.beginPath();
        context.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        context.arc(dotX, dotY, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    const positionSettled =
      Math.abs(state.targetX - state.currentX) < 0.2 &&
      Math.abs(state.targetY - state.currentY) < 0.2;
    const warpSettled = Math.abs(state.targetWarp - state.currentWarp) < 0.01;
    const tintSettled = Math.abs(state.targetTint - state.currentTint) < 0.01;

    if (
      !positionSettled ||
      !warpSettled ||
      !tintSettled ||
      state.currentWarp > 0.01 ||
      state.currentTint > 0.01
    ) {
      state.rafId = window.requestAnimationFrame(drawFrame);
      return;
    }

    state.rafId = null;
  };

  const scheduleFrame = () => {
    const state = stateRef.current;
    if (state.rafId !== null) {
      return;
    }
    state.rafId = window.requestAnimationFrame(drawFrame);
  };
  scheduleFrameRef.current = scheduleFrame;

  useImperativeHandle(ref, () => ({
    setPointer(x: number, y: number) {
      const state = stateRef.current;
      state.targetX = x;
      state.targetY = y;
      state.targetWarp = 1;
      state.targetTint = 1;
      if (state.currentTint === 0) {
        state.currentX = x;
        state.currentY = y;
      }
      if (idleFadeTimerRef.current) {
        clearTimeout(idleFadeTimerRef.current);
      }
      // 关键交互：滑过时放大，鼠标一停就自动恢复原样，不需要等鼠标离开面板。
      idleFadeTimerRef.current = setTimeout(() => {
        stateRef.current.targetWarp = 0;
        stateRef.current.targetTint = IDLE_TINT_HOLD;
        scheduleFrameRef.current();
      }, IDLE_FADE_DELAY_MS);
      scheduleFrameRef.current();
    },
    clearPointer() {
      if (idleFadeTimerRef.current) {
        clearTimeout(idleFadeTimerRef.current);
        idleFadeTimerRef.current = null;
      }
      stateRef.current.targetWarp = 0;
      stateRef.current.targetTint = 0;
      scheduleFrameRef.current();
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    const state = stateRef.current;
    if (!canvas) {
      return;
    }

    const observer = new ResizeObserver(() => {
      scheduleFrameRef.current();
    });
    observer.observe(canvas);
    scheduleFrameRef.current();

    return () => {
      observer.disconnect();
      if (idleFadeTimerRef.current) {
        clearTimeout(idleFadeTimerRef.current);
        idleFadeTimerRef.current = null;
      }
      if (state.rafId !== null) {
        window.cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
});
