import React from 'react';
import { Check, X, ShieldCheck, Zap, Sparkles } from 'lucide-react';

export const ComparisonMatrix: React.FC = () => {
  const features = [
    {
      feature: 'Context Retrieval',
      rag: 'Vector Similarity Search (flat text chunks)',
      graphyti: 'Graph Traversal + HydraDB Hybrid Search',
      highlight: true,
    },
    {
      feature: 'Edit Mechanism',
      rag: 'Full-file regeneration (prone to deletion bugs)',
      graphyti: 'Scoped structural edits only',
      highlight: false,
    },
    {
      feature: 'Pre-write Safety Check',
      rag: 'None (or unverified LLM self-report)',
      graphyti: 'Blast radius computed from graph before disk write',
      highlight: true,
    },
    {
      feature: 'Post-gen Verification',
      rag: 'None (trust the generated output)',
      graphyti: 'Dual Independent Checks (Local ts-morph AST + HydraDB)',
      highlight: true,
    },
    {
      feature: 'Failure Behavior',
      rag: 'Writes partial/broken files directly to disk',
      graphyti: 'Blocks disk write entirely; 0 partial files landed',
      highlight: true,
    },
    {
      feature: 'Shell Command Guard',
      rag: 'Often unrestricted or basic prompt confirmation',
      graphyti: 'Strict allowlist (npm install, prisma generate, prisma migrate dev)',
      highlight: false,
    },
  ];

  return (
    <section id="comparison" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div className="glass-pill glass-pill-cyan" style={{ marginBottom: '16px' }}>
            <Sparkles size={14} color="#00f2fe" />
            <span>Why Graphyti Wins</span>
          </div>
          <h2 className="font-heading" style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', marginBottom: '12px' }}>
            Graphyti vs. RAG-Only Code Tools
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '700px', margin: '0 auto' }}>
            Why simple similarity search isn't enough to prevent dangerous structural code regressions.
          </p>
        </div>

        {/* Matrix Table Card */}
        <div className="glass-panel" style={{ padding: '32px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '650px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)' }}>
                <th style={{ padding: '16px 20px', fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 700, width: '25%' }}>
                  Feature / Guardrail
                </th>
                <th style={{ padding: '16px 20px', fontSize: '1rem', color: '#f43f5e', fontWeight: 700, width: '35%' }}>
                  Embedding / RAG-Only Tools
                </th>
                <th style={{ padding: '16px 20px', fontSize: '1.05rem', color: '#00f2fe', fontWeight: 800, width: '40%', background: 'rgba(0, 242, 254, 0.05)', borderRadius: '12px 12px 0 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ShieldCheck size={18} color="#00f2fe" />
                    <span>Graphyti CLI</span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {features.map((row, idx) => (
                <tr
                  key={idx}
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                    background: row.highlight ? 'rgba(255, 255, 255, 0.01)' : 'transparent',
                  }}
                >
                  <td style={{ padding: '18px 20px', fontWeight: 700, color: '#fff', fontSize: '0.92rem' }}>
                    {row.feature}
                  </td>
                  <td style={{ padding: '18px 20px', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                      <X size={16} color="#f43f5e" style={{ marginTop: '2px', flexShrink: 0 }} />
                      <span>{row.rag}</span>
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '18px 20px',
                      color: '#e2e8f0',
                      fontWeight: 600,
                      fontSize: '0.9rem',
                      background: 'rgba(0, 242, 254, 0.04)',
                      borderLeft: '1px solid rgba(0, 242, 254, 0.1)',
                      borderRight: '1px solid rgba(0, 242, 254, 0.1)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                      <Check size={16} color="#00f2fe" style={{ marginTop: '2px', flexShrink: 0 }} />
                      <span style={{ color: '#00f2fe' }}>{row.graphyti}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};
