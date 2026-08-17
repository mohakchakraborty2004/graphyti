import React from 'react';
import { Layers, Search, Edit3, Network, ShieldCheck, Terminal, ArrowRight, CheckCircle } from 'lucide-react';

export const ArchitectureFlow: React.FC = () => {
  const steps = [
    {
      num: '01',
      title: 'Deterministic Extraction',
      subtitle: 'Static Analysis Parser',
      description: 'ts-morph AST analysis + Prisma schema parser extracts exact models, fields, API routes, and component tree without LLM guesses.',
      icon: Search,
      badge: 'ts-morph + Prisma',
      color: '#00f2fe',
    },
    {
      num: '02',
      title: 'Scoped Structured Edits',
      subtitle: 'Targeted Operations',
      description: 'LLM never rewrites full files. Proposes scoped operations (e.g. rename_field) anchored directly to AST target lines.',
      icon: Edit3,
      badge: 'Zero Hallucinated Lines',
      color: '#38bdf8',
    },
    {
      num: '03',
      title: 'Pre-Write Blast Radius',
      subtitle: 'Graph Traversal',
      description: 'Computes exact dependent files, API routes, and rendering components BEFORE writing a single byte to disk.',
      icon: Network,
      badge: 'Computed Relations',
      color: '#c084fc',
    },
    {
      num: '04',
      title: 'Dual Verification Layers',
      subtitle: 'Double Verification',
      description: '1. Local ts-morph AST re-parse.\n2. HydraDB relation graph staging to catch stale or orphaned nodes across files.',
      icon: ShieldCheck,
      badge: 'Local AST + HydraDB',
      color: '#a855f7',
    },
    {
      num: '05',
      title: 'Execution Allowlist',
      subtitle: 'Strict Command Boundary',
      description: 'Only allowlisted commands (npm install, prisma generate, prisma migrate dev) can execute with user confirmation.',
      icon: Terminal,
      badge: 'Strict Security',
      color: '#10b981',
    },
  ];

  return (
    <section id="architecture" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div className="glass-pill glass-pill-purple" style={{ marginBottom: '16px' }}>
            <Layers size={14} color="#c084fc" />
            <span>Under The Hood</span>
          </div>
          <h2 className="font-heading" style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', marginBottom: '12px' }}>
            The 5-Step Guaranteed Verification Pipeline
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '750px', margin: '0 auto' }}>
            How Graphyti guarantees zero structural hallucination across your codebase.
          </p>
        </div>

        {/* Step Cards Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '20px',
            position: 'relative',
          }}
        >
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <div
                key={index}
                className="glass-panel"
                style={{
                  padding: '24px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  position: 'relative',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                    <span className="font-mono" style={{ fontSize: '1.4rem', fontWeight: 800, color: step.color }}>
                      {step.num}
                    </span>
                    <div
                      style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '8px',
                        background: `${step.color}15`,
                        border: `1px solid ${step.color}40`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon size={18} color={step.color} />
                    </div>
                  </div>

                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>
                    {step.title}
                  </h3>
                  <div style={{ fontSize: '0.8rem', color: step.color, fontWeight: 600, marginBottom: '12px' }}>
                    {step.subtitle}
                  </div>

                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '16px', whiteSpace: 'pre-line' }}>
                    {step.description}
                  </p>
                </div>

                <span
                  style={{
                    fontSize: '0.72rem',
                    padding: '4px 10px',
                    borderRadius: '9999px',
                    fontWeight: 700,
                    background: 'rgba(255, 255, 255, 0.04)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    color: '#e2e8f0',
                    width: 'fit-content',
                  }}
                >
                  {step.badge}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
