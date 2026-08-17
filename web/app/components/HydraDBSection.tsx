'use client';

import React from 'react';
import { Database, RefreshCw, Search, ShieldCheck } from 'lucide-react';

export const HydraDBSection: React.FC = () => {
  const roles = [
    { title: '1. Ingestion', file: 'src/graph/ingest.ts', desc: 'Every extracted AST node & Prisma schema model is ingested into HydraDB with forceful relation edges.', icon: Database },
    { title: '2. Incremental Sync', file: 'src/graph/incremental.ts', desc: 'After every successful write, Graphyti re-ingests only modified nodes for zero-cost updates.', icon: RefreshCw },
    { title: '3. Grounded Retrieval', file: 'src/generate/retrieveContext.ts', desc: 'Replaces flat context files with HydraDB hybrid search + graph context traversal.', icon: Search },
    { title: '4. Independent Verification', file: 'src/graph/hydraVerify.ts', desc: 'Proposed edits are staged into HydraDB and cross-checked against stored relations before writing.', icon: ShieldCheck },
  ];

  return (
    <section id="hydradb" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        <div style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '36px', borderRadius: '4px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // LOAD-BEARING GRAPH STORE
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5', marginBottom: '24px' }}>
            HydraDB Integration Architecture
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '20px' }}>
            {roles.map((r, i) => {
              const Icon = r.icon;
              return (
                <div key={i} style={{ border: '1px solid #1f1f1f', background: '#050505', padding: '20px', borderRadius: '2px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', color: '#ff6a1a' }}>
                    <Icon size={16} />
                    <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f5f5f5' }}>{r.title}</h3>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', marginBottom: '8px' }}>{r.file}</div>
                  <p style={{ fontSize: '0.82rem', color: '#8a8a8a', lineHeight: 1.5, margin: 0 }}>{r.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};
