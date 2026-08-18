'use client';

import { useRef, useEffect, useCallback } from 'react';

const BLOCK_SIZE = 7;
const CYCLE_DURATION = 3600;
const REGION_COLS = 10;
const REGION_ROWS = 7;
const GRID_COLS = 32;
const GRID_ROWS = 20;
const REGION_START_COL = 11;
const REGION_START_ROW = 6;

export function EditAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const startTimeRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    const elapsed = performance.now() - startTimeRef.current;
    const t = (elapsed % CYCLE_DURATION) / CYCLE_DURATION;

    const regionX = REGION_START_COL * BLOCK_SIZE + (W - GRID_COLS * BLOCK_SIZE) / 2;
    const regionY = REGION_START_ROW * BLOCK_SIZE + (H - GRID_ROWS * BLOCK_SIZE) / 2;
    const regionW = REGION_COLS * BLOCK_SIZE;
    const regionH = REGION_ROWS * BLOCK_SIZE;

    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const bx = col * BLOCK_SIZE + (W - GRID_COLS * BLOCK_SIZE) / 2;
        const by = row * BLOCK_SIZE + (H - GRID_ROWS * BLOCK_SIZE) / 2;

        const inRegion =
          col >= REGION_START_COL &&
          col < REGION_START_COL + REGION_COLS &&
          row >= REGION_START_ROW &&
          row < REGION_START_ROW + REGION_ROWS;

        if (inRegion) {
          const localCol = col - REGION_START_COL;
          const localRow = row - REGION_START_ROW;

          const regionProgress = t * 2;
          const cellDelay = (localCol * 0.5 + localRow * 0.25) * 0.12;
          const cellProgress = Math.max(0, Math.min(1, regionProgress - cellDelay));

          const centerDistX = (localCol - REGION_COLS / 2) / (REGION_COLS / 2);
          const centerDistY = (localRow - REGION_ROWS / 2) / (REGION_ROWS / 2);
          const centerDist = Math.sqrt(centerDistX * centerDistX + centerDistY * centerDistY);
          const centerFalloff = 1 - centerDist * 0.4;

          const flicker = Math.sin(elapsed * 0.006 + localCol * 1.8 + localRow * 2.5) * 0.25 + 0.75;
          const intensity = cellProgress * flicker * centerFalloff;

          if (t < 0.25) {
            const sweep = Math.sin(elapsed * 0.004 + localCol * 0.3) * 0.2 + 0.8;
            const r = Math.floor(60 + 195 * intensity * sweep);
            const g = Math.floor(50 + 56 * intensity * sweep);
            ctx.fillStyle = `rgb(${r}, ${g}, 15)`;
          } else if (t < 0.5) {
            const pulse = Math.sin(elapsed * 0.006) * 0.2 + 0.8;
            const wave = Math.sin(elapsed * 0.003 + localCol * 0.5) * 0.15 + 0.85;
            const r = Math.floor(255 * intensity * pulse * wave);
            const g = Math.floor(106 * intensity * pulse * wave);
            ctx.fillStyle = `rgb(${r}, ${g}, 20)`;
          } else if (t < 0.75) {
            const shimmer = Math.sin(elapsed * 0.008 + localCol * 1.2 + localRow * 0.8) * 0.15 + 0.85;
            const r = Math.floor(255 * intensity * shimmer);
            const g = Math.floor(90 * intensity * shimmer);
            ctx.fillStyle = `rgb(${r}, ${g}, 15)`;
          } else {
            const settle = Math.min(1, (t - 0.75) / 0.2);
            const r = Math.floor(255 * intensity * settle);
            const g = Math.floor(80 * intensity * settle);
            ctx.fillStyle = `rgb(${r}, ${g}, 12)`;
          }

          ctx.fillRect(bx, by, BLOCK_SIZE - 1, BLOCK_SIZE - 1);
        } else {
          const dimVal = 22 + Math.floor(Math.sin(col * 0.4 + row * 0.6) * 4);
          ctx.fillStyle = `rgb(${dimVal}, ${dimVal}, ${dimVal})`;
          ctx.fillRect(bx, by, BLOCK_SIZE - 1, BLOCK_SIZE - 1);
        }
      }
    }

    if (t < 0.9) {
      const pulse = Math.sin(elapsed * 0.005) * 0.15 + 0.35;
      ctx.strokeStyle = `rgba(255, 106, 26, ${pulse * (1 - t)})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.lineDashOffset = elapsed * 0.02;
      ctx.strokeRect(regionX - 3, regionY - 3, regionW + 6, regionH + 6);
      ctx.setLineDash([]);
    }

    if (t > 0.1 && t < 0.8) {
      const scanY = regionY + (t - 0.1) / 0.7 * regionH;
      const scanAlpha = Math.sin((t - 0.1) / 0.7 * Math.PI) * 0.3;
      ctx.fillStyle = `rgba(255, 106, 26, ${scanAlpha})`;
      ctx.fillRect(regionX, scanY - 1, regionW, 2);
    }

    animRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w > 0 && h > 0) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    handleResize();
    const ro = new ResizeObserver(handleResize);
    ro.observe(canvas.parentElement!);

    startTimeRef.current = performance.now();
    animRef.current = requestAnimationFrame(draw);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(animRef.current);
    };
  }, [draw]);

  return (
    <div className="edit-anim-wrap">
      <canvas ref={canvasRef} className="edit-canvas" />
    </div>
  );
}
