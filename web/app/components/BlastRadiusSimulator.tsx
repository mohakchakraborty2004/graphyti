'use client';

import React, { useState } from 'react';
import { Network, ShieldAlert, ShieldCheck, Check } from 'lucide-react';

export const BlastRadiusSimulator: React.FC = () => {
  const [selectedMutation, setSelectedMutation] = useState<string>('rename');

  const mutations = [
    {
      id: 'rename',
      title: 'Rename User.email → username',
      nodes: [
        { path: 'prisma/schema.prisma', detail: 'model User: field email' },
        { path: 'app/api/user/profile/route.ts', detail: 'GET query selecting email' },
        { path: 'components/UserProfileCard.tsx', detail: 'renders user.email prop' },
        { path: 'types/user.ts', detail: 'UserInterface email field' },
      ],
      rag: 'Wrote 1 file, missed 2 frontend components. Production runtime crash.',
      graphyti: 'Dual verification passed. All 4 files updated in single atomic write.',
    },
    {
      id: 'delete',
      title: 'Delete Post.authorId',
      nodes: [
        { path: 'prisma/schema.prisma', detail: 'model Post: authorId relation' },
        { path: 'app/api/posts/route.ts', detail: 'queries authorId' },
        { path: 'components/AuthorBadge.tsx', detail: 'renders authorId' },
      ],
      rag: 'Wrote 2 files, left broken component. Build failed on deploy.',
      graphyti: 'Stage 2 HydraDB check detected 2 orphaned relations. Disk write blocked cleanly.',
    },
  ];

  const current = mutations.find((m) => m.id === selectedMutation) || mutations[0];

  return (
    <section id="blast-radius" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // PRE-WRITE BLAST RADIUS TRAVERSAL
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5' }}>
            Computed Dependency Blast Radius
          </h2>
        </div>

        {/* Mutation Tabs */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
          {mutations.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelectedMutation(m.id)}
              className="btn-pill-outlined"
              style={{
                borderColor: selectedMutation === m.id ? '#ff6a1a' : '#2a2a2a',
                color: selectedMutation === m.id ? '#ff6a1a' : '#8a8a8a',
                fontSize: '0.85rem',
                padding: '8px 18px',
              }}
            >
              {m.title}
            </button>
          ))}
        </div>

        {/* Simulator Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px' }}>
          {/* Tree Box */}
          <div style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '24px', borderRadius: '4px' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#f5f5f5', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Network size={16} color="#ff6a1a" />
              <span>Graph Computed Dependents ({current.nodes.length})</span>
            </h3>

            {current.nodes.map((node, i) => (
              <div key={i} style={{ padding: '10px 14px', border: '1px solid #1f1f1f', background: '#050505', marginBottom: '8px', borderRadius: '2px' }}>
                <div style={{ fontSize: '0.85rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {node.path}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#8a8a8a' }}>{node.detail}</div>
              </div>
            ))}
          </div>

          {/* Comparison Boxes */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ border: '1px solid rgba(244, 63, 94, 0.3)', background: 'rgba(244, 63, 94, 0.04)', padding: '20px', borderRadius: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f43f5e', fontWeight: 700, fontSize: '0.92rem', marginBottom: '6px' }}>
                <ShieldAlert size={16} />
                <span>RAG / Embedding AI Agent</span>
              </div>
              <p style={{ fontSize: '0.82rem', color: '#8a8a8a', margin: 0 }}>{current.rag}</p>
            </div>

            <div style={{ border: '1px solid rgba(255, 106, 26, 0.4)', background: 'rgba(255, 106, 26, 0.04)', padding: '20px', borderRadius: '4px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ff6a1a', fontWeight: 700, fontSize: '0.92rem', marginBottom: '6px' }}>
                <ShieldCheck size={16} />
                <span>Graphyti (Deterministic Graph Verification)</span>
              </div>
              <p style={{ fontSize: '0.82rem', color: '#f5f5f5', margin: 0 }}>{current.graphyti}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
