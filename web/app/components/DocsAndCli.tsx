'use client';

import React, { useState } from 'react';
import { Terminal, Copy, Check, ShieldCheck } from 'lucide-react';

export const DocsAndCli: React.FC = () => {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (txt: string, id: string) => {
    navigator.clipboard.writeText(txt);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const cmds = [
    { cmd: 'graphyti graph init', desc: 'Builds deterministic codebase graph via ts-morph AST & Prisma schema parser.' },
    { cmd: 'graphyti "rename Post.title to headline"', desc: 'Executes scoped field mutation, calculates blast radius, runs dual verification.' },
    { cmd: 'graphyti "add priority field to Post" --dry-run', desc: 'Previews blast radius and AST updates with ZERO side effects or disk changes.' },
    { cmd: 'graphyti "add priority field" --yes --json', desc: 'Executes non-interactively for CI/CD pipelines, outputting structured JSON.' },
  ];

  return (
    <section id="docs" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // CLI REFERENCE & SECURITY BOUNDARY
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5' }}>
            Documentation & Command Guardrails
          </h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px' }}>
          {/* Cmds */}
          <div style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '24px', borderRadius: '4px' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#f5f5f5', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Terminal size={16} color="#ff6a1a" />
              <span>CLI Usage Reference</span>
            </h3>

            {cmds.map((item, i) => (
              <div key={i} style={{ border: '1px solid #1f1f1f', background: '#050505', padding: '12px', marginBottom: '10px', borderRadius: '2px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <code style={{ color: '#ff6a1a', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}>$ {item.cmd}</code>
                  <button onClick={() => copy(item.cmd, `c-${i}`)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8a8a8a' }}>
                    {copied === `c-${i}` ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                  </button>
                </div>
                <p style={{ fontSize: '0.78rem', color: '#8a8a8a', margin: 0 }}>{item.desc}</p>
              </div>
            ))}
          </div>

          {/* Security & Exit Codes */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '20px', borderRadius: '4px' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f5f5f5', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ShieldCheck size={16} color="#10b981" />
                <span>Command Execution Allowlist</span>
              </h4>
              <p style={{ fontSize: '0.8rem', color: '#8a8a8a', marginBottom: '10px' }}>Only allowlisted shell commands can execute:</p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}>
                <span style={{ border: '1px solid #2a2a2a', padding: '4px 10px', background: '#050505', color: '#10b981' }}>npm install</span>
                <span style={{ border: '1px solid #2a2a2a', padding: '4px 10px', background: '#050505', color: '#10b981' }}>prisma generate</span>
                <span style={{ border: '1px solid #2a2a2a', padding: '4px 10px', background: '#050505', color: '#10b981' }}>prisma migrate dev</span>
              </div>
            </div>

            <div style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '20px', borderRadius: '4px' }}>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f5f5f5', marginBottom: '10px' }}>Clean Scriptable Exit Codes</h4>
              <div style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                <div style={{ display: 'flex', gap: '12px', marginBottom: '6px' }}><span style={{ color: '#10b981', fontWeight: 700 }}>0</span><span style={{ color: '#8a8a8a' }}>Success (Dual verification passed)</span></div>
                <div style={{ display: 'flex', gap: '12px', marginBottom: '6px' }}><span style={{ color: '#eab308', fontWeight: 700 }}>1</span><span style={{ color: '#8a8a8a' }}>Verification Blocked (0 partial files written)</span></div>
                <div style={{ display: 'flex', gap: '12px' }}><span style={{ color: '#f43f5e', fontWeight: 700 }}>2</span><span style={{ color: '#8a8a8a' }}>System Error (Missing config/network)</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
