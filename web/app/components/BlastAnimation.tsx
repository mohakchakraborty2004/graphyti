'use client';

import { useRef, useEffect } from 'react';

const BLOCK_SIZE = 6;
const CYCLE_MS = 2200;
const NUM_RINGS = 4;

export function BlastAnimation() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let running = true;

    const sizeCanvas = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    sizeCanvas();

    const ro = new ResizeObserver(sizeCanvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const start = performance.now();

    const draw = (now: number) => {
      if (!running) return;

      sizeCanvas();

      const W = canvas.width;
      const H = canvas.height;
      if (W === 0 || H === 0) {
        raf = requestAnimationFrame(draw);
        return;
      }

      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, W, H);

      const elapsed = (now - start) % (CYCLE_MS * 2);
      const cycleT = elapsed < CYCLE_MS ? elapsed / CYCLE_MS : 1;
      const holdT = elapsed < CYCLE_MS ? 0 : (elapsed - CYCLE_MS) / CYCLE_MS;

      const cx = W / 2;
      const cy = H / 2;
      const maxR = Math.sqrt(cx * cx + cy * cy);

      const cols = Math.ceil(W / BLOCK_SIZE);
      const rows = Math.ceil(H / BLOCK_SIZE);

      const t = cycleT;
      const fade = holdT > 0 ? Math.max(0, 1 - holdT * 2) : 1;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const bx = col * BLOCK_SIZE;
          const by = row * BLOCK_SIZE;
          const dx = bx + BLOCK_SIZE / 2 - cx;
          const dy = by + BLOCK_SIZE / 2 - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const nd = dist / maxR;

          for (let ring = 0; ring < NUM_RINGS; ring++) {
            const rr = t * (1.1 + ring * 0.18) + ring * 0.18;
            const rw = 0.2 - ring * 0.025;
            const rd = Math.abs(nd - rr);

            if (rd < rw) {
              const strength = (1 - rd / rw) * (1 - ring * 0.18) * fade;
              const flick = 0.7 + Math.sin(col * 7.3 + row * 11.7 + now * 0.003 + ring * 2.5) * 0.3;
              const i = strength * flick * (1 - nd * 0.5);

              if (i > 0.04) {
                const r = Math.floor(255 * i);
                const g = Math.floor(80 * i * (1 - nd * 0.4));
                const b = Math.floor(20 * i);
                ctx.fillStyle = `rgba(${r},${g},${b},${i})`;
                ctx.fillRect(bx, by, BLOCK_SIZE - 1, BLOCK_SIZE - 1);
              }
            }
          }

          if (t > 0.25 && t < 0.85 && fade > 0.3) {
            const sc = Math.sin(col * 3.7 + row * 5.3 + now * 0.005) * 0.5 + 0.5;
            const thresh = 0.93 + (t - 0.25) * 0.08;
            if (sc > thresh && nd > 0.08 && nd < 0.92) {
              const si = (1 - Math.abs(nd - t) * 2.2) * fade * 0.5;
              if (si > 0) {
                const fl = Math.sin(now * 0.01 + col + row * 3) * 0.3 + 0.7;
                const fi = si * fl;
                ctx.fillStyle = `rgba(${Math.floor(255 * fi)},${Math.floor(90 * fi)},20,${fi})`;
                ctx.fillRect(bx, by, BLOCK_SIZE - 1, BLOCK_SIZE - 1);
              }
            }
          }
        }
      }

      const pulseR = t * maxR * 0.85;
      const pw = 6 + t * 14;
      const pa = (1 - t * 0.6) * fade * 0.3;
      if (pa > 0.01 && pulseR > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,106,26,${pa})`;
        ctx.lineWidth = pw;
        ctx.stroke();
      }

      const ga = fade * 0.12 * (1 + Math.sin(now * 0.008) * 0.3);
      if (ga > 0.01) {
        const gr = maxR * 0.35 * (1 - t * 0.4);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, gr);
        grad.addColorStop(0, `rgba(255,106,26,${ga})`);
        grad.addColorStop(1, 'rgba(255,106,26,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="blast-anim-wrap">
      <canvas ref={canvasRef} className="blast-canvas" />
    </div>
  );
}
