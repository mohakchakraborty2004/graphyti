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

const CHARS = ['#', '@', '#', '@', '#', '@', '#', '@', '#'];
const REST = [22, 22, 22] as const;
const REST_BRIGHT = [38, 38, 38] as const;
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
    let interactive = window.matchMedia('(pointer: fine)').matches;

    const fontSize = window.innerWidth < 720 ? 12 : 14;
    const cellW = window.innerWidth < 720 ? 13 : 14;
    const cellH = window.innerWidth < 720 ? 15 : 16;
    const radius = interactive ? 220 : 0;
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

      // Graph nodes for subtle density variation
      const nodes = [
        { x: cols * 0.12, y: rows * 0.35, r: 8 },
        { x: cols * 0.30, y: rows * 0.20, r: 10 },
        { x: cols * 0.50, y: rows * 0.45, r: 12 },
        { x: cols * 0.22, y: rows * 0.70, r: 9 },
        { x: cols * 0.70, y: rows * 0.28, r: 8 },
        { x: cols * 0.65, y: rows * 0.72, r: 7 },
        { x: cols * 0.85, y: rows * 0.50, r: 9 },
        { x: cols * 0.40, y: rows * 0.85, r: 8 },
      ];
      const edges = [[0, 1], [1, 2], [2, 3], [2, 4], [3, 5], [4, 5], [4, 6], [3, 7]] as const;

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          let shape = 0.06;
          for (const node of nodes) {
            const d = Math.hypot(col - node.x, row - node.y);
            if (d < node.r) shape += (1 - d / node.r) * 0.9;
          }
          for (const [a, b] of edges) {
            const d = distToSeg(col, row, nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y);
            if (d < 2) shape += (1 - d / 2) * 0.6;
          }
          if (shape < 0.10 && Math.random() > 0.35) continue;

          const grain = Math.random();
          const charIndex = Math.min(CHARS.length - 1, Math.floor((shape * 0.6 + grain * 0.5) * CHARS.length));
          const restT = Math.min(1, 0.15 + Math.min(shape, 1) * 0.4 + (grain > 0.8 ? 0.5 : grain * 0.15));
          const glyph: Glyph = {
            char: CHARS[charIndex],
            x: col * cellW + (grain - 0.5) * 1.8,
            y: row * cellH,
            r: mix(REST[0], REST_BRIGHT[0], restT),
            g: mix(REST[1], REST_BRIGHT[1], restT),
            b: mix(REST[2], REST_BRIGHT[2], restT),
            a: Math.min(0.85, 0.18 + shape * 0.45),
            noise: 0.15 + grain * 1.2,
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
          const grain = Math.max(0, g.noise * (0.4 + Math.sin(t * 0.02 + g.phase) * 0.6));
          accent = Math.min(1, Math.pow(falloff, 1.3) * grain * (0.6 + burst));
        }
        g.glow = accent > g.glow ? accent : g.glow * 0.82;
        if (g.glow > 0.02) {
          const k = g.glow;
          ctx.fillStyle = `rgba(${mix(g.r, ACCENT[0], k)},${mix(g.g, ACCENT[1], k)},${mix(g.b, ACCENT[2], k)},${Math.min(0.98, g.a + k * 0.75)})`;
          ctx.fillText(g.char, g.x, g.y);
        }
      }

      if (Math.random() < 0.5 && glyphs.length) {
        const n = 3 + ((Math.random() * 5) | 0);
        for (let i = 0; i < n; i += 1) {
          glyphs[(Math.random() * glyphs.length) | 0].flick = 0.2 + Math.random() * 0.4;
        }
      }
      for (const g of glyphs) {
        if (g.flick <= 0.02) continue;
        g.flick *= 0.82;
        const f = g.flick;
        ctx.fillStyle = `rgba(${mix(g.r, REST_BRIGHT[0], f)},${mix(g.g, REST_BRIGHT[1], f)},${mix(g.b, REST_BRIGHT[2], f)},${Math.min(0.95, g.a + f * 0.35)})`;
        ctx.fillText(g.char, g.x, g.y);
      }

      if (burst > 0.01) burst *= 0.88;
    };

    const loop = () => {
      draw(performance.now());
      raf = requestAnimationFrame(loop);
    };

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      interactive = window.matchMedia('(pointer: fine)').matches;
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
