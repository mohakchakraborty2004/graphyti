'use client';

import { useRef, useEffect, useCallback } from 'react';

const BLOCK_SIZE = 6;
const CYCLE_DURATION = 2000;
const NUM_RINGS = 4;

export function BlastAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const startTimeRef = useRef(0);
  const isRunningRef = useRef(false);

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
    const t = Math.min(1, elapsed / CYCLE_DURATION);

    const cx = W / 2;
    const cy = H / 2;
    const maxRadius = Math.sqrt(cx * cx + cy * cy);

    const cols = Math.ceil(W / BLOCK_SIZE);
    const rows = Math.ceil(H / BLOCK_SIZE);

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const bx = col * BLOCK_SIZE;
        const by = row * BLOCK_SIZE;
        const dx = bx + BLOCK_SIZE / 2 - cx;
        const dy = by + BLOCK_SIZE / 2 - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const normalizedDist = dist / maxRadius;

        for (let ring = 0; ring < NUM_RINGS; ring++) {
          const ringOffset = ring * 0.2;
          const ringRadius = t * (1.2 + ring * 0.15) + ringOffset;
          const ringWidth = 0.18 - ring * 0.02;

          const ringDist = Math.abs(normalizedDist - ringRadius);
          const inRing = ringDist < ringWidth;

          if (inRing) {
            const ringStrength = 1 - ringDist / ringWidth;
            const fadeEdge = normalizedDist;
            const intensity = ringStrength * (1 - fadeEdge * 0.5) * (1 - ring * 0.15);

            const flickerSeed = Math.sin(col * 7.3 + row * 11.7 + elapsed * 0.003 + ring * 2.5);
            const flicker = 0.7 + flickerSeed * 0.3;
            const finalIntensity = intensity * flicker * (1 - t * 0.4);

            const r = Math.floor(255 * finalIntensity);
            const g = Math.floor(80 * finalIntensity * (1 - fadeEdge * 0.4));
            const b = Math.floor(20 * finalIntensity * (1 - fadeEdge * 0.3));
            const a = finalIntensity;

            if (a > 0.05) {
              ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
              ctx.fillRect(bx, by, BLOCK_SIZE - 1, BLOCK_SIZE - 1);
            }
          }
        }

        if (t > 0.3 && t < 0.85) {
          const scatterChance = Math.sin(col * 3.7 + row * 5.3 + elapsed * 0.005) * 0.5 + 0.5;
          const scatterThreshold = 0.92 + (t - 0.3) * 0.1;
          if (scatterChance > scatterThreshold && normalizedDist > 0.1 && normalizedDist < 0.9) {
            const scatterIntensity = (1 - Math.abs(normalizedDist - t) * 2) * (1 - t);
            if (scatterIntensity > 0) {
              const flicker = Math.sin(elapsed * 0.01 + col + row * 3) * 0.3 + 0.7;
              const si = scatterIntensity * flicker * 0.6;
              ctx.fillStyle = `rgba(${Math.floor(255 * si)}, ${Math.floor(90 * si)}, ${Math.floor(20 * si)}, ${si})`;
              ctx.fillRect(bx, by, BLOCK_SIZE - 1, BLOCK_SIZE - 1);
            }
          }
        }
      }
    }

    const pulseR = t * maxRadius * 0.8;
    const pulseWidth = 8 + t * 12;
    const pulseAlpha = (1 - t) * 0.25;
    if (pulseAlpha > 0.01) {
      ctx.beginPath();
      ctx.arc(cx, cy, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 106, 26, ${pulseAlpha})`;
      ctx.lineWidth = pulseWidth;
      ctx.stroke();
    }

    const glowAlpha = (1 - t) * 0.15 * (1 + Math.sin(elapsed * 0.008) * 0.3);
    if (glowAlpha > 0.01) {
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxRadius * 0.4 * (1 - t * 0.5));
      gradient.addColorStop(0, `rgba(255, 106, 26, ${glowAlpha})`);
      gradient.addColorStop(1, 'rgba(255, 106, 26, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, W, H);
    }

    if (t < 1) {
      animRef.current = requestAnimationFrame(draw);
    } else {
      isRunningRef.current = false;
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animRef.current);
    };
  }, []);

  const startAnimation = useCallback(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;
    startTimeRef.current = performance.now();
    animRef.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    const interval = setInterval(() => {
      startAnimation();
    }, 3000);

    startAnimation();

    return () => {
      clearInterval(interval);
      cancelAnimationFrame(animRef.current);
    };
  }, [startAnimation]);

  return (
    <div className="blast-anim-wrap">
      <canvas ref={canvasRef} className="blast-canvas" />
    </div>
  );
}
