'use client';

import React, { useState } from 'react';
import { Network, Database, Info } from 'lucide-react';

interface Node {
  id: string;
  name: string;
  type: 'model' | 'route' | 'component' | 'hydradb';
  props: string[];
  x: number;
  y: number;
}

const nodes: Node[] = [
  { id: 'user', name: 'User Model', type: 'model', props: ['id: String @id', 'email: String', 'name: String'], x: 140, y: 100 },
  { id: 'post', name: 'Post Model', type: 'model', props: ['id: String @id', 'title: String', 'authorId: String'], x: 420, y: 100 },
  { id: 'route-posts', name: 'GET /api/posts', type: 'route', props: ['prisma.post.findMany()', 'select title'], x: 550, y: 260 },
  { id: 'route-user', name: 'GET /api/user', type: 'route', props: ['prisma.user.findUnique()', 'select email'], x: 140, y: 260 },
  { id: 'hydradb', name: 'HydraDB Store', type: 'hydradb', props: ['Staged Relation Graph', 'Orphan Node Guard'], x: 340, y: 220 },
];

export const CodeGraphVisualizer: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string>('post');
  const selected = nodes.find((n) => n.id === selectedId) || nodes[0];

  return (
    <section id="graph" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // DETERMINISTIC CODEBASE GRAPH
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5' }}>
            HydraDB Staged Graph Inspector
          </h2>
        </div>

        {/* Canvas & Inspector Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 2fr) minmax(260px, 1fr)', gap: '24px' }}>
          <div style={{ border: '1px solid #2a2a2a', background: '#050505', height: '380px', position: 'relative', borderRadius: '4px' }}>
            <svg style={{ width: '100%', height: '100%' }}>
              <line x1={140} y1={100} x2={420} y2={100} stroke="#2a2a2a" strokeWidth={1.5} />
              <line x1={420} y1={100} x2={550} y2={260} stroke="#2a2a2a" strokeWidth={1.5} />
              <line x1={140} y1={100} x2={140} y2={260} stroke="#2a2a2a" strokeWidth={1.5} />
              <line x1={340} y1={220} x2={140} y2={100} stroke="#ff6a1a" strokeWidth={1} strokeDasharray="4,4" />
              <line x1={340} y1={220} x2={420} y2={100} stroke="#ff6a1a" strokeWidth={1} strokeDasharray="4,4" />

              {nodes.map((n) => {
                const isSelected = n.id === selectedId;
                return (
                  <g key={n.id} onClick={() => setSelectedId(n.id)} style={{ cursor: 'pointer' }} transform={`translate(${n.x}, ${n.y})`}>
                    <circle r={isSelected ? 22 : 16} fill="#0d0d0d" stroke={isSelected ? '#ff6a1a' : '#2a2a2a'} strokeWidth={isSelected ? 2.5 : 1.5} />
                    <text textAnchor="middle" dy="4" fill="#f5f5f5" fontSize="9" fontFamily="var(--font-mono)">
                      {n.name.slice(0, 6)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Node Inspector */}
          <div style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '24px', borderRadius: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', color: '#ff6a1a' }}>
              <Info size={16} />
              <span style={{ fontSize: '0.9rem', fontWeight: 700 }}>Node Inspector</span>
            </div>

            <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f5f5f5', marginBottom: '4px' }}>{selected.name}</div>
            <div style={{ fontSize: '0.75rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', marginBottom: '16px' }}>
              TYPE: {selected.type.toUpperCase()}
            </div>

            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', background: '#050505', padding: '12px', borderRadius: '2px', border: '1px solid #1f1f1f' }}>
              {selected.props.map((p, i) => (
                <div key={i} style={{ color: '#8a8a8a', marginBottom: '4px' }}>• {p}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
