'use client';

import { useEffect, useRef } from 'react';

type Glyph = {
  char: string;
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
  noise: number;
  phase: number;
  glow: number;
  flick: number;
  col: number;
  row: number;
};

const CHARS = ['.', ':', ';', '+', '=', '*', '#', '%', '@'];
const REST = [28, 28, 28] as const;
const REST_BRIGHT = [44, 44, 44] as const;
const ACCENT = [255, 106, 26] as const;

function mix(a: number, b: number, t: number) {
  return Math.round(a + (b - a) * t);
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function AsciiNoiseField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !ctx) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = { x: -9999, y: -9999, active: false, dirty: false };
    let glyphs: Glyph[] = [];
    let bins = new Map<string, Glyph[]>();
    let staticLayer: HTMLCanvasElement | null = null;
    let staticCtx: CanvasRenderingContext2D | null = null;
    let width = 0;
    let height = 0;
    let raf = 0;
    let dpr = 1;
    let burst = 0;
    let reduced = motion.matches;
    let interactive = window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 900;

    const fontSize = window.innerWidth < 720 ? 11 : 13;
    const cellW = window.innerWidth < 720 ? 12 : 13;
    const cellH = window.innerWidth < 720 ? 14 : 15;
    const radius = interactive ? 155 : 0;
    const binSize = 48;

    const binKey = (x: number, y: number) => `${Math.floor(x / binSize)},${Math.floor(y / binSize)}`;

    const nearby = (x: number, y: number) => {
      const hits: Glyph[] = [];
      const seen = new Set<Glyph>();
      const r = Math.ceil(radius / binSize) + 1;
      const cx = Math.floor(x / binSize);
      const cy = Math.floor(y / binSize);
      for (let yb = cy - r; yb <= cy + r; yb += 1) {
        for (let xb = cx - r; xb <= cx + r; xb += 1) {
          const list = bins.get(`${xb},${yb}`);
          if (!list) continue;
          for (const g of list) {
            if (seen.has(g)) continue;
            seen.add(g);
            hits.push(g);
          }
        }
      }
      return hits;
    };

    const buildGlyphs = () => {
      glyphs = [];
      bins = new Map();
      const cols = Math.ceil(width / cellW);
      const rows = Math.ceil(height / cellH);
      const nodes = [
        { x: cols * 0.16, y: rows * 0.48, r: 5.2 },
        { x: cols * 0.34, y: rows * 0.28, r: 6.8 },
        { x: cols * 0.52, y: rows * 0.54, r: 9.1 },
        { x: cols * 0.28, y: rows * 0.76, r: 6.4 },
        { x: cols * 0.72, y: rows * 0.34, r: 5.8 },
        { x: cols * 0.66, y: rows * 0.78, r: 5.0 },
      ];
      const edges = [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 5]] as const;

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          let shape = 0.03;
          for (const node of nodes) {
            const d = Math.hypot(col - node.x, row - node.y);
            if (d < node.r) shape += (1 - d / node.r) * 0.82;
          }
          for (const [a, b] of edges) {
            const d = distToSeg(col, row, nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y);
            if (d < 1.5) shape += (1 - d / 1.5) * 0.5;
          }
          if (shape < 0.12 && Math.random() > 0.22) continue;

          const grain = Math.random();
          const charIndex = Math.min(CHARS.length - 1, Math.floor((shape * 0.7 + grain * 0.4) * CHARS.length));
          const restT = Math.min(1, 0.12 + Math.min(shape, 1) * 0.35 + (grain > 0.82 ? 0.45 : grain * 0.12));
          const glyph: Glyph = {
            char: CHARS[charIndex],
            x: col * cellW + (grain - 0.5) * 1.6,
            y: row * cellH,
            r: mix(REST[0], REST_BRIGHT[0], restT),
            g: mix(REST[1], REST_BRIGHT[1], restT),
            b: mix(REST[2], REST_BRIGHT[2], restT),
            a: Math.min(0.92, 0.16 + shape * 0.42),
            noise: 0.12 + grain * 1.15,
            phase: grain * 240,
            glow: 0,
            flick: 0,
            col,
            row,
          };
          glyphs.push(glyph);
          const key = binKey(glyph.x, glyph.y);
          const list = bins.get(key);
          if (list) list.push(glyph);
          else bins.set(key, [glyph]);
        }
      }
    };

    const font = () => `${fontSize}px "Fira Code", ui-monospace, monospace`;

    const paintStatic = () => {
      if (!staticLayer || !staticCtx) return;
      staticLayer.width = Math.floor(width * dpr);
      staticLayer.height = Math.floor(height * dpr);
      staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      staticCtx.clearRect(0, 0, width, height);
      staticCtx.font = font();
      staticCtx.textBaseline = 'top';
      for (const g of glyphs) {
        staticCtx.fillStyle = `rgba(${g.r},${g.g},${g.b},${g.a})`;
        staticCtx.fillText(g.char, g.x, g.y);
      }
    };

    const draw = (t: number) => {
      if (staticLayer) ctx.drawImage(staticLayer, 0, 0, width, height);
      if (reduced || !interactive) return;

      ctx.font = font();
      ctx.textBaseline = 'top';

      const candidates = pointer.active ? nearby(pointer.x, pointer.y) : [];
      for (const g of candidates) {
        const dist = Math.hypot(g.x - pointer.x, g.y - pointer.y);
        let accent = 0;
        if (dist < radius) {
          const falloff = 1 - dist / radius;
          const grain = Math.max(0, g.noise * (0.35 + Math.sin(t * 0.018 + g.phase) * 0.55));
          accent = Math.min(1, Math.pow(falloff, 1.45) * grain * (0.55 + burst));
        }
        g.glow = accent > g.glow ? accent : g.glow * 0.86;
        if (g.glow > 0.02) {
          const k = g.glow;
          ctx.fillStyle = `rgba(${mix(g.r, ACCENT[0], k)},${mix(g.g, ACCENT[1], k)},${mix(g.b, ACCENT[2], k)},${Math.min(0.98, g.a + k * 0.7)})`;
          ctx.fillText(g.char, g.x, g.y);
        }
      }

      if (Math.random() < 0.45 && glyphs.length) {
        const n = 2 + ((Math.random() * 4) | 0);
        for (let i = 0; i < n; i += 1) {
          glyphs[(Math.random() * glyphs.length) | 0].flick = 0.18 + Math.random() * 0.38;
        }
      }
      for (const g of glyphs) {
        if (g.flick <= 0.02) continue;
        g.flick *= 0.84;
        const f = g.flick;
        ctx.fillStyle = `rgba(${mix(g.r, REST_BRIGHT[0], f)},${mix(g.g, REST_BRIGHT[1], f)},${mix(g.b, REST_BRIGHT[2], f)},${Math.min(0.95, g.a + f * 0.3)})`;
        ctx.fillText(g.char, g.x, g.y);
      }

      if (burst > 0.01) burst *= 0.9;
    };

    const loop = () => {
      draw(performance.now());
      raf = requestAnimationFrame(loop);
    };

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      interactive = window.matchMedia('(pointer: fine)').matches && window.innerWidth >= 900;
      reduced = motion.matches;
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cancelAnimationFrame(raf);
      buildGlyphs();
      paintStatic();
      if (reduced || !interactive) {
        if (staticLayer) ctx.drawImage(staticLayer, 0, 0, width, height);
      } else {
        loop();
      }
    };

    const onMove = (event: PointerEvent) => {
      if (reduced || !interactive) return;
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      if (!pointer.active) burst = 1;
      pointer.active = true;
      pointer.dirty = true;
    };

    const onLeave = () => {
      pointer.active = false;
      pointer.x = -9999;
      pointer.y = -9999;
    };

    staticLayer = document.createElement('canvas');
    staticCtx = staticLayer.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerleave', onLeave);
    motion.addEventListener('change', resize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      motion.removeEventListener('change', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="ascii-canvas" aria-hidden="true" />;
}
