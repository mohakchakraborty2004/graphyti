'use client';

import { useRef, useEffect, useCallback, ReactNode } from 'react';

type AnimatedBackgroundProps = {
  children?: ReactNode;
  density?: number;
  speed?: number;
  waveAmplitude?: number;
  waveFrequency?: number;
  glowRadius?: number;
  enableHover?: boolean;
  restingColor?: [number, number, number];
  peakColor?: [number, number, number];
  className?: string;
};

const GLYPHS = ['@', '#', '%', '+'];
const CHAR_W = 13;
const CHAR_H = 18;

export function AnimatedBackground({
  children,
  density = 0.6,
  speed = 0.4,
  waveAmplitude = 1,
  waveFrequency = 0.03,
  glowRadius = 140,
  enableHover = true,
  restingColor = [0.18, 0.18, 0.18],
  peakColor = [1.0, 0.42, 0.1],
  className,
}: AnimatedBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -1000, y: -1000 });
  const animRef = useRef<number>(0);
  const prefersReduced = useRef(false);
  const lastFrameRef = useRef(0);

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (timestamp - lastFrameRef.current < 33) {
      animRef.current = requestAnimationFrame(draw);
      return;
    }
    lastFrameRef.current = timestamp;

    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0, 0, W, H);

    const mx = mouseRef.current.x;
    const my = mouseRef.current.y;

    const cols = Math.ceil(W / CHAR_W) + 1;
    const rows = Math.ceil(H / CHAR_H) + 1;

    const time = prefersReduced.current ? 0 : performance.now() / 1000;

    const r255 = peakColor[0] * 255;
    const g255 = peakColor[1] * 255;
    const b255 = peakColor[2] * 255;
    const rr = restingColor[0] * 255;
    const gr = restingColor[1] * 255;
    const br = restingColor[2] * 255;

    ctx.font = '13px "Fira Code", monospace';
    ctx.textBaseline = 'middle';

    for (let row = 0; row < rows; row++) {
      const py = row * CHAR_H + CHAR_H * 0.55;
      const rowFreq = row * waveFrequency * 0.5;

      for (let col = 0; col < cols; col++) {
        const px = col * CHAR_W;

        const waveVal = Math.sin(col * waveFrequency + time * speed + rowFreq);
        const waveT = (waveVal + 1) * 0.5;
        const wAmp = waveT * waveAmplitude;

        let r = rr + (r255 - rr) * wAmp;
        let g = gr + (g255 - gr) * wAmp;
        let b = br + (b255 - br) * wAmp;
        let alpha = 1;
        let glyph = GLYPHS[(col * 3 + row * 7) & 3];

        if (enableHover) {
          const dx = px + CHAR_W * 0.5 - mx;
          const dy = py - my;
          const distSq = dx * dx + dy * dy;
          const glowSq = glowRadius * glowRadius;

          if (distSq < glowSq) {
            const dist = Math.sqrt(distSq);
            const proximity = 1 - dist / glowRadius;
            const flicker = 0.85 + Math.sin(time * 8 + dist * 0.08) * 0.15;
            const strength = proximity * flicker;

            r = r255 * strength;
            g = g255 * strength * 0.42;
            b = b255 * strength * 0.1;
            alpha = strength;
            glyph = GLYPHS[((col * 7 + row * 13 + (time * 12) | 0)) & 3];
          }
        }

        if (wAmp > 0.6) {
          glyph = GLYPHS[((col + row + (time * 2) | 0)) & 3];
        }

        const ri = r | 0;
        const gi = g | 0;
        const bi = b | 0;

        if (alpha < 1) {
          ctx.fillStyle = `rgba(${ri},${gi},${bi},${alpha.toFixed(2)})`;
        } else {
          ctx.fillStyle = `rgb(${ri},${gi},${bi})`;
        }
        ctx.fillText(glyph, px, py);
      }
    }

    if (!prefersReduced.current) {
      animRef.current = requestAnimationFrame(draw);
    }
  }, [density, speed, waveAmplitude, waveFrequency, glowRadius, enableHover, restingColor, peakColor]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReduced.current = mq.matches;

    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = parent.clientWidth * dpr;
      canvas.height = parent.clientHeight * dpr;
      canvas.style.width = parent.clientWidth + 'px';
      canvas.style.height = parent.clientHeight + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(dpr, dpr);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    animRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animRef.current);
    };
  }, [draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    mouseRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  const handleMouseLeave = useCallback(() => {
    mouseRef.current = { x: -1000, y: -1000 };
  }, []);

  return (
    <div
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      {children}
    </div>
  );
}
