'use client';

import { useEffect, useRef } from 'react';

export function GraphDatabase3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let time = 0;

    // Graph nodes
    const nodes = [
      { x: 0, y: 0, z: 0, label: 'User', color: '#D97757' },
      { x: 1.2, y: 0.5, z: 0.3, label: 'Post', color: '#D9A05B' },
      { x: -0.8, y: 0.8, z: -0.2, label: 'Comment', color: '#79C77B' },
      { x: 0.5, y: -0.7, z: 0.5, label: 'Like', color: '#E06C6C' },
      { x: -0.5, y: -0.4, z: -0.6, label: 'Route', color: '#00f2fe' },
      { x: 1.0, y: -0.8, z: -0.3, label: 'Component', color: '#a855f7' },
    ];

    // Edges
    const edges = [
      [0, 1], [0, 2], [0, 3], [1, 2], [1, 4], [1, 5], [2, 4], [3, 5], [4, 5],
    ];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const project = (x: number, y: number, z: number, t: number) => {
      const cos = Math.cos(t * 0.0004);
      const sin = Math.sin(t * 0.0004);
      const rx = x * cos - z * sin;
      const rz = x * sin + z * cos;

      const cosY = Math.cos(t * 0.0002);
      const sinY = Math.sin(t * 0.0002);
      const ry2 = y * cosY - rz * sinY;
      const rz2 = y * sinY + rz * cosY;

      const scale = 2.5 / (3 + rz2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      return {
        x: w / 2 + rx * scale * w * 0.3,
        y: h / 2 + ry2 * scale * h * 0.3,
        scale,
      };
    };

    const draw = (t: number) => {
      time = t;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // Project nodes
      const projected = nodes.map(n => ({
        ...n,
        ...project(n.x, n.y, n.z, t),
      }));

      // Draw edges
      ctx.lineWidth = 1;
      for (const [a, b] of edges) {
        const na = projected[a];
        const nb = projected[b];
        const pulse = (Math.sin(t * 0.003 + a + b) + 1) / 2;
        ctx.strokeStyle = `rgba(255, 106, 26, ${0.15 + pulse * 0.2})`;
        ctx.beginPath();
        ctx.moveTo(na.x, na.y);
        ctx.lineTo(nb.x, nb.y);
        ctx.stroke();
      }

      // Draw nodes
      for (const node of projected) {
        const size = 6 * node.scale;
        const pulse = (Math.sin(t * 0.002 + node.x) + 1) / 2;

        // Glow
        ctx.shadowColor = node.color;
        ctx.shadowBlur = 12 + pulse * 8;

        ctx.fillStyle = node.color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;

        // Label
        ctx.fillStyle = '#f5f5f5';
        ctx.font = `${Math.max(9, 11 * node.scale)}px "Fira Code", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(node.label, node.x, node.y + size + 14);
      }
    };

    const loop = () => {
      draw(performance.now());
      raf = requestAnimationFrame(loop);
    };

    resize();
    window.addEventListener('resize', resize);
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="feature-visual graph-db-visual">
      <canvas ref={canvasRef} className="graph-db-canvas" />
    </div>
  );
}
