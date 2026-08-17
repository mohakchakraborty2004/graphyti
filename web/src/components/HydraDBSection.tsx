import React from 'react';
import { Cpu, RefreshCw, Search, ShieldCheck, Database } from 'lucide-react';

export const HydraDBSection: React.FC = () => {
  const roles = [
    {
      icon: Database,
      title: '1. Ingestion',
      file: 'src/graph/ingest.ts',
      description: 'Every extracted node (Prisma models, fields, routes, components) is ingested into HydraDB as a knowledge record with forceful relation edges.',
      color: '#00f2fe',
    },
    {
      icon: RefreshCw,
      title: '2. Incremental Sync',
      file: 'src/graph/incremental.ts',
      description: 'After every successful write, Graphyti re-ingests only the changed nodes, maintaining zero-cost incremental updates.',
      color: '#38bdf8',
    },
    {
      icon: Search,
      title: '3. Grounded Retrieval',
      file: 'src/generate/retrieveContext.ts',
      description: 'Replaces flat, bloated context files with HydraDB hybrid search + graph traversal to pass accurate, focused context to the LLM.',
      color: '#c084fc',
    },
    {
      icon: ShieldCheck,
      title: '4. Independent Verification',
      file: 'src/graph/hydraVerify.ts',
      description: 'The core differentiator: proposed edits are staged into HydraDB and cross-checked against stored relations before disk writes proceed.',
      color: '#a855f7',
    },
  ];

  return (
    <section id="hydradb" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Section Header */}
        <div className="glass-panel glass-panel-purple" style={{ padding: '40px', position: 'relative', overflow: 'hidden' }}>
          <div className="glow-orb" style={{ top: '-50px', right: '-50px', width: '300px', height: '300px', background: 'radial-gradient(circle, rgba(168,85,247,0.2) 0%, transparent 70%)' }}></div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '10px',
                background: 'rgba(168, 85, 247, 0.15)',
                border: '1px solid rgba(168, 85, 247, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Cpu size={22} color="#c084fc" />
            </div>
            <div>
              <h2 className="font-heading" style={{ fontSize: '2rem', fontWeight: 800, color: '#fff' }}>
                HydraDB Integration Architecture
              </h2>
              <span style={{ fontSize: '0.9rem', color: '#c084fc', fontWeight: 600 }}>
                Graph Store & Staged Knowledge Verification Engine
              </span>
            </div>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: '1.05rem', maxWidth: '850px', lineHeight: 1.6, marginBottom: '32px' }}>
            HydraDB isn't a bolt-on for Graphyti — it acts as the primary knowledge store and verification authority across four distinct execution stages.
          </p>

          {/* 4 Roles Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '20px' }}>
            {roles.map((role, idx) => {
              const Icon = role.icon;
              return (
                <div
                  key={idx}
                  style={{
                    padding: '20px',
                    borderRadius: '12px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <Icon size={18} color={role.color} />
                    <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff' }}>{role.title}</h3>
                  </div>

                  <div style={{ fontSize: '0.75rem', color: role.color, fontFamily: 'var(--font-mono)', marginBottom: '8px' }}>
                    {role.file}
                  </div>

                  <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {role.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};
