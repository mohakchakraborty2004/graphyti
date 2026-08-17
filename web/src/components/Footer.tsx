import React from 'react';
import { Network, Github, Heart, ShieldCheck } from 'lucide-react';

export const Footer: React.FC = () => {
  return (
    <footer
      style={{
        borderTop: '1px solid rgba(255, 255, 255, 0.08)',
        background: 'rgba(4, 5, 8, 0.95)',
        padding: '60px 24px 30px',
        position: 'relative',
        zIndex: 10,
      }}
    >
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '40px', marginBottom: '40px' }}>
          {/* Brand Col */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'rgba(0, 242, 254, 0.15)',
                  border: '1px solid rgba(0, 242, 254, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Network size={20} color="#00f2fe" />
              </div>
              <span className="font-heading" style={{ fontSize: '1.3rem', fontWeight: 800, color: '#fff' }}>
                GRAPHYTI
              </span>
            </div>

            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: '320px' }}>
              A CLI coding agent that treats your codebase's structure as ground truth — verified twice before touching disk.
            </p>
          </div>

          {/* Tech Stack Col */}
          <div>
            <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', marginBottom: '14px' }}>
              Underlying Technology
            </h4>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span className="glass-pill glass-pill-cyan" style={{ fontSize: '0.75rem' }}>ts-morph (AST)</span>
              <span className="glass-pill glass-pill-cyan" style={{ fontSize: '0.75rem' }}>Prisma Parser</span>
              <span className="glass-pill glass-pill-purple" style={{ fontSize: '0.75rem' }}>HydraDB Graph</span>
              <span className="glass-pill glass-pill-purple" style={{ fontSize: '0.75rem' }}>OpenRouter LLM</span>
              <span className="glass-pill glass-pill-emerald" style={{ fontSize: '0.75rem' }}>Commander TUI</span>
            </div>
          </div>

          {/* Core Claim Pill */}
          <div>
            <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#fff', marginBottom: '14px' }}>
              Core Guarantee
            </h4>
            <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(0, 242, 254, 0.05)', border: '1px solid rgba(0, 242, 254, 0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', color: '#00f2fe', fontWeight: 700, marginBottom: '4px' }}>
                <ShieldCheck size={16} />
                <span>Zero Partial Disk Writes</span>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
                If either local AST check or HydraDB graph check fails, Graphyti writes NOTHING to disk.
              </p>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div
          style={{
            borderTop: '1px solid rgba(255, 255, 255, 0.05)',
            paddingTop: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
          }}
        >
          <div>
            Released under the <strong>MIT License</strong>. Graphyti CLI Hackathon Edition.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <span>HydraDB Hackathon Submission</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
