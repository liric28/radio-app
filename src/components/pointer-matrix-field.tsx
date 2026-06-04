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
  // 画布当前 CSS 尺寸和像素比，用来把 canvas 同步到清晰分辨率。
  width: number;
  height: number;
  dpr: number;
  // currentX/currentY 是当前动画帧里的鼓包中心；targetX/targetY 是最新鼠标位置。
  currentX: number;
  currentY: number;
  targetX: number;
  targetY: number;
  // warp 控制点位形变强度；tint 控制绿色染色强度。
  // 二者拆开是为了实现“停住先回位，但绿色还能留一点”的效果。
  currentWarp: number;
  targetWarp: number;
  currentTint: number;
  targetTint: number;
  // 当前 requestAnimationFrame 句柄；为 null 表示当前没有进行中的绘制循环。
  rafId: number | null;
};

// 点阵基础列距/行距。数值越大，面板里的点越稀。
const GRID_GAP = 18;
// 默认灰点半径，未被交互影响时每个点的尺寸。
const BASE_RADIUS = 1.22;
// 鼓包影响半径。鼠标附近这片区域内的矩阵点会参与形变和染色。
const LENS_RADIUS = 160;
// 形变的最大放大倍率。越大，鼠标经过时“透视鼓包”越明显。
const LENS_MAX_SCALE = 1.42;
// 绿色高亮的最大透明度。
const LENS_MAX_ALPHA = 1;
// 鼓包区域里的矩阵点大小控制。只影响跟随鼠标的那片点，不影响默认灰点大小。
const LENS_DOT_RADIUS = 1.6;
// 鼠标停止移动后，延迟多久开始回位。
const IDLE_FADE_DELAY_MS = 200;
// 停住后保留的绿色强度。0 是完全恢复灰点；越大越偏绿色残留。
const IDLE_TINT_HOLD = 0.72;

// 限制到 0..1，避免权重或插值越界。
function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

// 线性插值：t=0 取 a，t=1 取 b，中间按比例混合。
function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

// 让 canvas 的实际像素尺寸跟 DOM 尺寸和设备像素比同步，避免 Retina 下发糊。
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

// 鼓包权重函数。
// 越靠近鼠标中心返回值越大，越靠外越接近 0。
// 这里用平滑曲线而不是硬截断，避免形变边缘出现生硬折痕。
function resolveLensWeight(distance: number) {
  const normalized = clamp01(1 - distance / LENS_RADIUS);
  return normalized * normalized * (3 - 2 * normalized);
}

export const PointerMatrixField = forwardRef<
  PointerMatrixFieldHandle,
  PointerMatrixFieldProps
>(function PointerMatrixField({ className, theme }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // theme 用 ref 存，避免在 RAF 绘制里读到闭包旧值。
  const themeRef = useRef(theme);
  // 跟随系统“减少动态效果”设置，必要时把补间直接拉满，避免过度动画。
  const reducedMotionRef = useRef(false);
  // 统一的启动绘制入口。外部事件只负责改 target，不直接管 RAF 生命周期。
  const scheduleFrameRef = useRef<() => void>(() => {});
  // 鼠标停止后触发“回位但保留部分绿色”的延迟定时器。
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

  // 跟随系统无障碍设置，动态切换 reduced motion。
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

    // reduced motion 开启时直接快速收敛；否则用平滑补间。
    const reducedMotion = reducedMotionRef.current;
    const positionEase = reducedMotion ? 1 : 0.24;
    const warpEase = reducedMotion ? 1 : 0.18;
    const tintEase = reducedMotion ? 1 : 0.14;

    // 所有可动画状态都朝 target 收敛，不直接一步跳过去。
    state.currentX += (state.targetX - state.currentX) * positionEase;
    state.currentY += (state.targetY - state.currentY) * positionEase;
    state.currentWarp += (state.targetWarp - state.currentWarp) * warpEase;
    state.currentTint += (state.targetTint - state.currentTint) * tintEase;

    const width = state.width;
    const height = state.height;
    const dpr = state.dpr;
    // baseColor 是默认矩阵灰点；lensColor 是交互时的绿色点。
    const baseColor =
      themeRef.current === "light"
        ? { r: 88, g: 80, b: 128, a: 0.32 }
        : { r: 244, g: 243, b: 248, a: 0.36 };
    const lensColor =
      themeRef.current === "light"
        ? { r: 62, g: 201, b: 132, a: 0.94 }
        : { r: 84, g: 216, b: 140, a: 0.98 };

    // 每帧先清空整张画布，再按当前动画状态重画整片矩阵。
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    // 遍历整个矩阵。
    // 这里没有额外叠一层“特效点”，而是底层这批点本身参与位移和染色。
    for (let y = GRID_GAP / 2; y < height; y += GRID_GAP) {
      for (let x = GRID_GAP / 2; x < width; x += GRID_GAP) {
        const dx = x - state.currentX;
        const dy = y - state.currentY;
        const distance = Math.hypot(dx, dy);
        const lensWeight = resolveLensWeight(distance);
        const warpWeight = lensWeight * state.currentWarp;
        const tintWeight = lensWeight * state.currentTint;
        const safeDistance = distance || 1;
        // warpWeight 决定点位被“鼓包”推开的程度。
        const scale = 1 + warpWeight * (LENS_MAX_SCALE - 1);
        const dotX = state.currentX + (dx / safeDistance) * (safeDistance * scale);
        const dotY = state.currentY + (dy / safeDistance) * (safeDistance * scale);
        // tintWeight 影响颜色和鼓包区域里的点大小。
        const radius = mix(BASE_RADIUS, LENS_DOT_RADIUS, tintWeight);
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

    // 所有状态都已经接近目标值时，停止 RAF，避免空转。
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
    // 只有当前没在画时才启动下一帧，避免重复 requestAnimationFrame。
    state.rafId = window.requestAnimationFrame(drawFrame);
  };
  scheduleFrameRef.current = scheduleFrame;

  useImperativeHandle(ref, () => ({
    // 鼠标移动时更新鼓包中心，并把形变/染色目标拉满。
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
      // 关键交互：
      // 1. 鼠标滑过时立即出现鼓包
      // 2. 鼠标停住一段时间后，点位先回到原矩阵
      // 3. 绿色不完全消失，而是保留到 IDLE_TINT_HOLD
      idleFadeTimerRef.current = setTimeout(() => {
        stateRef.current.targetWarp = 0;
        stateRef.current.targetTint = IDLE_TINT_HOLD;
        scheduleFrameRef.current();
      }, IDLE_FADE_DELAY_MS);
      scheduleFrameRef.current();
    },
    // 鼠标离开面板时，形变和绿色一起彻底清空。
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

    // 面板尺寸变化时重新触发一帧，让矩阵重算宽高和排布。
    const observer = new ResizeObserver(() => {
      scheduleFrameRef.current();
    });
    observer.observe(canvas);
    scheduleFrameRef.current();

    return () => {
      observer.disconnect();
      // 卸载时清理定时器和 RAF，避免后台残留回调。
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
