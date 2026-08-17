'use client';

import React from 'react';
import { Search, Edit3, Network, ShieldCheck, Terminal } from 'lucide-react';

export const ArchitectureFlow: React.FC = () => {
  const steps = [
    { num: '01', title: 'Deterministic Extraction', desc: 'ts-morph AST analysis + Prisma schema parser builds code graph without LLM guesses.', icon: Search },
    { num: '02', title: 'Scoped Structured Edits', desc: 'LLM proposes narrow operations (e.g. rename_field) anchored directly to AST target lines.', icon: Edit3 },
    { num: '03', title: 'Pre-Write Blast Radius', desc: 'Traverses relation graph to compute dependent routes, components, and schemas before disk writes.', icon: Network },
    { num: '04', title: 'Dual Verification Layers', desc: '1. Local ts-morph AST re-parse.\n2. HydraDB relation graph staging check.', icon: ShieldCheck },
    { num: '05', title: 'Execution Allowlist', desc: 'Strict execution boundary (npm install, prisma generate, prisma migrate dev).', icon: Terminal },
  ];

  return (
    <section id="architecture" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // VERIFICATION PIPELINE
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5' }}>
            The 5-Step Execution Pipeline
          </h2>
        </div>

        {/* Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={i} style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '24px', borderRadius: '4px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '1.2rem', fontWeight: 800, color: '#ff6a1a' }}>{step.num}</span>
                    <Icon size={18} color="#8a8a8a" />
                  </div>
                  <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#f5f5f5', marginBottom: '8px' }}>{step.title}</h3>
                  <p style={{ fontSize: '0.82rem', color: '#8a8a8a', lineHeight: 1.5, whiteSpace: 'pre-line' }}>{step.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
