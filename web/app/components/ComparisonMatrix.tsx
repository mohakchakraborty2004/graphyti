'use client';

import React from 'react';
import { Check, X, ShieldCheck } from 'lucide-react';

export const ComparisonMatrix: React.FC = () => {
  const rows = [
    { name: 'Context Retrieval', rag: 'Vector similarity search (flat text)', graphyti: 'Graph traversal + HydraDB hybrid search' },
    { name: 'Edit Mechanism', rag: 'Full-file regeneration', graphyti: 'Scoped structural edits only' },
    { name: 'Pre-write Safety Check', rag: 'None (or unverified LLM self-report)', graphyti: 'Blast radius computed from graph before disk write' },
    { name: 'Post-gen Verification', rag: 'None (trust the generated output)', graphyti: 'Two independent checks (Local ts-morph AST + HydraDB)' },
    { name: 'Failure Behavior', rag: 'Writes whatever was generated directly to disk', graphyti: 'Blocks write entirely if verification fails; 0 partial files' },
    { name: 'Shell Command Boundary', rag: 'Often unrestricted execution', graphyti: 'Strict allowlist + explicit confirmation' },
  ];

  return (
    <section id="comparison" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // STRUCTURAL VERIFICATION DIFFERENTIATOR
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5' }}>
            Embedding / RAG Tools vs. Graphyti
          </h2>
        </div>

        <div style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', borderRadius: '4px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '650px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={{ padding: '16px 20px', fontSize: '0.9rem', color: '#8a8a8a', width: '25%' }}>Feature</th>
                <th style={{ padding: '16px 20px', fontSize: '0.9rem', color: '#f43f5e', width: '35%' }}>RAG / Embedding Tools</th>
                <th style={{ padding: '16px 20px', fontSize: '0.95rem', color: '#ff6a1a', fontWeight: 700, width: '40%' }}>Graphyti CLI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={{ padding: '16px 20px', fontWeight: 600, color: '#f5f5f5', fontSize: '0.88rem' }}>{r.name}</td>
                  <td style={{ padding: '16px 20px', color: '#8a8a8a', fontSize: '0.85rem' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <X size={14} color="#f43f5e" style={{ flexShrink: 0, marginTop: '2px' }} />
                      <span>{r.rag}</span>
                    </div>
                  </td>
                  <td style={{ padding: '16px 20px', color: '#f5f5f5', fontWeight: 600, fontSize: '0.88rem', background: 'rgba(255, 106, 26, 0.03)' }}>
                    <div style={{ display: 'flex', gap: '8px', color: '#ff6a1a' }}>
                      <Check size={14} color="#ff6a1a" style={{ flexShrink: 0, marginTop: '2px' }} />
                      <span>{r.graphyti}</span>
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
