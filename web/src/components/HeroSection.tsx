import React from 'react';
import { Network, ShieldAlert, Cpu, ArrowRight, CheckCircle2, Terminal, Sparkles, Layers, FileCode } from 'lucide-react';

interface HeroSectionProps {
  onExploreSandbox: () => void;
  onExploreBlastRadius: () => void;
}

export const HeroSection: React.FC<HeroSectionProps> = ({ onExploreSandbox, onExploreBlastRadius }) => {
  return (
    <section id="hero" style={{ padding: '80px 24px 60px', position: 'relative', overflow: 'hidden' }}>
      {/* Background Glow Orbs */}
      <div className="glow-orb" style={{ top: '-100px', left: '20%', width: '500px', height: '500px', background: 'radial-gradient(circle, rgba(0,242,254,0.15) 0%, transparent 70%)' }}></div>
      <div className="glow-orb" style={{ top: '100px', right: '10%', width: '600px', height: '600px', background: 'radial-gradient(circle, rgba(168,85,247,0.15) 0%, transparent 70%)' }}></div>

      <div style={{ maxWidth: '1280px', margin: '0 auto', textAlign: 'center', position: 'relative', zIndex: 1 }}>
        {/* Top Feature Pill */}
        <div style={{ display: 'inline-flex', marginBottom: '24px' }}>
          <div className="glass-pill glass-pill-cyan" style={{ padding: '8px 18px', fontSize: '0.9rem' }}>
            <Sparkles size={16} color="#00f2fe" />
            <span>Eliminating Structural Hallucination in AI Coding</span>
            <span style={{ background: 'rgba(0, 242, 254, 0.2)', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 700 }}>
              VERIFIED
            </span>
          </div>
        </div>

        {/* Main Headline */}
        <h1
          className="font-heading"
          style={{
            fontSize: 'clamp(2.5rem, 5vw, 4.5rem)',
            fontWeight: 800,
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
            marginBottom: '24px',
            maxWidth: '1050px',
            margin: '0 auto 24px',
          }}
        >
          Your Codebase Structure as{' '}
          <span className="gradient-text-cyan">Ground Truth</span>
          <br />
          <span style={{ fontSize: '0.85em', color: 'rgba(255, 255, 255, 0.9)' }}>
            Not something the LLM has to remember.
          </span>
        </h1>

        {/* Subtitle */}
        <p
          style={{
            fontSize: '1.2rem',
            color: 'var(--text-muted)',
            maxWidth: '820px',
            margin: '0 auto 40px',
            lineHeight: 1.6,
          }}
        >
          Graphyti generates code changes like standard AI tools, but with a fundamental safety claim:{' '}
          <strong style={{ color: '#fff', fontWeight: 600 }}>
            a deterministic code graph checks its work twice before anything touches your disk.
          </strong>
        </p>

        {/* Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', flexWrap: 'wrap', marginBottom: '60px' }}>
          <button onClick={onExploreSandbox} className="btn-glass-primary">
            <Terminal size={18} />
            <span>Try Live CLI Sandbox</span>
            <ArrowRight size={18} />
          </button>

          <button onClick={onExploreBlastRadius} className="btn-glass-secondary">
            <Network size={18} color="#00f2fe" />
            <span>Simulate Blast Radius</span>
          </button>
        </div>

        {/* Key Feature Stats Cards (Glass UI) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '20px',
            textAlign: 'left',
          }}
        >
          {/* Card 1 */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  background: 'rgba(244, 63, 94, 0.1)',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ShieldAlert size={20} color="#f43f5e" />
              </div>
              <span className="glass-pill glass-pill-emerald" style={{ fontSize: '0.75rem' }}>100% Protected</span>
            </div>
            <div className="font-heading" style={{ fontSize: '2rem', fontWeight: 800, color: '#fff', marginBottom: '6px' }}>
              0
            </div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>
              Structural Hallucinations
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Models physically cannot invent non-existent fields or delete dependent components because edits are strictly scoped and verified.
            </p>
          </div>

          {/* Card 2 */}
          <div className="glass-panel glass-panel-cyan" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  background: 'rgba(0, 242, 254, 0.1)',
                  border: '1px solid rgba(0, 242, 254, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Layers size={20} color="#00f2fe" />
              </div>
              <span className="glass-pill glass-pill-cyan" style={{ fontSize: '0.75rem' }}>Dual Verification</span>
            </div>
            <div className="font-heading" style={{ fontSize: '2rem', fontWeight: 800, color: '#00f2fe', marginBottom: '6px' }}>
              2-Stage
            </div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>
              Independent Checks
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              1. Local ts-morph AST re-parse. <br />
              2. Staged HydraDB graph cross-check catching stale/orphaned nodes.
            </p>
          </div>

          {/* Card 3 */}
          <div className="glass-panel glass-panel-purple" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  background: 'rgba(168, 85, 247, 0.1)',
                  border: '1px solid rgba(168, 85, 247, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Cpu size={20} color="#c084fc" />
              </div>
              <span className="glass-pill glass-pill-purple" style={{ fontSize: '0.75rem' }}>HydraDB Engine</span>
            </div>
            <div className="font-heading" style={{ fontSize: '2rem', fontWeight: 800, color: '#c084fc', marginBottom: '6px' }}>
              Pre-Write
            </div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>
              Blast Radius Walk
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Computes affected API routes, Prisma schemas, and React components before touching disk. Zero silent breaks.
            </p>
          </div>

          {/* Card 4 */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <FileCode size={20} color="#10b981" />
              </div>
              <span className="glass-pill glass-pill-emerald" style={{ fontSize: '0.75rem' }}>Strict Boundary</span>
            </div>
            <div className="font-heading" style={{ fontSize: '2rem', fontWeight: 800, color: '#10b981', marginBottom: '6px' }}>
              Scoped
            </div>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>
              Targeted AST Edits
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              No full-file regeneration. The agent performs narrow, anchored structural operations with allowlist execution.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
};
