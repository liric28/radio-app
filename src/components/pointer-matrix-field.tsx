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
  currentStrength: number;
  targetStrength: number;
  rafId: number | null;
};

// 矩阵圆点间距
const GRID_GAP = 18;
// 矩阵圆点半径
const BASE_RADIUS = 1.6;
const PUSH_RADIUS = 200;
const MAX_PUSH = 9;
const MAX_SCALE = 1.1;

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

export const PointerMatrixField = forwardRef<
  PointerMatrixFieldHandle,
  PointerMatrixFieldProps
>(function PointerMatrixField({ className, theme }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeRef = useRef(theme);
  const reducedMotionRef = useRef(false);
  const scheduleFrameRef = useRef<() => void>(() => {});
  const stateRef = useRef<MatrixState>({
    width: 0,
    height: 0,
    dpr: 1,
    currentX: 0,
    currentY: 0,
    targetX: 0,
    targetY: 0,
    currentStrength: 0,
    targetStrength: 0,
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
    const positionEase = reducedMotion ? 1 : 0.22;
    const strengthEase = reducedMotion ? 1 : 0.16;

    state.currentX += (state.targetX - state.currentX) * positionEase;
    state.currentY += (state.targetY - state.currentY) * positionEase;
    state.currentStrength +=
      (state.targetStrength - state.currentStrength) * strengthEase;

    const width = state.width;
    const height = state.height;
    const dpr = state.dpr;
    // 矩阵圆点颜色和透明度
    const baseColor =
      themeRef.current === "light"
        ? { r: 88, g: 80, b: 128, a: 0.3 }
        : { r: 244, g: 243, b: 248, a: 0.36 };
    // 鼠标跟随悬停时的颜色和透明度
    const accentColor =
      themeRef.current === "light"
        ? { r: 62, g: 201, b: 132, a: 0.92 }
        : { r: 84, g: 216, b: 140, a: 0.96 };

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    for (let y = GRID_GAP / 2; y < height; y += GRID_GAP) {
      for (let x = GRID_GAP / 2; x < width; x += GRID_GAP) {
        const dx = x - state.currentX;
        const dy = y - state.currentY;
        const distance = Math.hypot(dx, dy);
        const falloff = clamp01(1 - distance / PUSH_RADIUS);
        const strength = state.currentStrength * falloff * falloff;
        const safeDistance = distance || 1;
        const push = strength * MAX_PUSH;
        const dotX = x + (dx / safeDistance) * push;
        const dotY = y + (dy / safeDistance) * push;
        const radius = BASE_RADIUS + strength * MAX_SCALE;
        const alpha = mix(baseColor.a, accentColor.a, strength);
        const r = Math.round(mix(baseColor.r, accentColor.r, strength));
        const g = Math.round(mix(baseColor.g, accentColor.g, strength));
        const b = Math.round(mix(baseColor.b, accentColor.b, strength));

        if (strength > 0.04) {
          context.beginPath();
          context.fillStyle = `rgba(${accentColor.r}, ${accentColor.g}, ${accentColor.b}, ${strength * 0.22})`;
          context.arc(dotX, dotY, radius + strength * 7.2, 0, Math.PI * 2);
          context.fill();
        }

        context.beginPath();
        context.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        context.arc(dotX, dotY, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    const positionSettled =
      Math.abs(state.targetX - state.currentX) < 0.2 &&
      Math.abs(state.targetY - state.currentY) < 0.2;
    const strengthSettled =
      Math.abs(state.targetStrength - state.currentStrength) < 0.01;

    if (!positionSettled || !strengthSettled || state.currentStrength > 0.01) {
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
      state.targetStrength = 1;
      if (state.currentStrength === 0) {
        state.currentX = x;
        state.currentY = y;
      }
      scheduleFrameRef.current();
    },
    clearPointer() {
      stateRef.current.targetStrength = 0;
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
      if (state.rafId !== null) {
        window.cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
});
