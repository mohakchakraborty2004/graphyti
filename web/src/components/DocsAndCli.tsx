import React, { useState } from 'react';
import { BookOpen, Terminal, Copy, Check, ShieldCheck, HelpCircle } from 'lucide-react';

export const DocsAndCli: React.FC = () => {
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(label);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  const cliCommands = [
    {
      cmd: 'graphyti graph init',
      desc: 'Builds the deterministic codebase graph via ts-morph AST & Prisma schema parser, syncing to HydraDB.',
    },
    {
      cmd: 'graphyti "rename Post.title to headline"',
      desc: 'Proposes a scoped field mutation, calculates blast radius, runs dual verification, and updates disk.',
    },
    {
      cmd: 'graphyti "add a priority field to Post" --dry-run',
      desc: 'Previews blast radius and AST updates with ZERO side effects or disk modifications.',
    },
    {
      cmd: 'graphyti "add priority field" --yes --json',
      desc: 'Executes non-interactively for CI/CD pipelines and scripts, outputting structured JSON logs.',
    },
  ];

  const exitCodes = [
    { code: '0', meaning: 'Success', detail: 'Both local AST check & HydraDB verification passed. Disk updated cleanly.' },
    { code: '1', meaning: 'Verification Blocked', detail: 'Verification failed. 0 partial files written to disk. Safe handled state.' },
    { code: '2', meaning: 'Unexpected Error', detail: 'Invalid parameters, missing config, or network issue.' },
  ];

  return (
    <section id="docs" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Section Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div className="glass-pill glass-pill-cyan" style={{ marginBottom: '16px' }}>
            <BookOpen size={14} color="#00f2fe" />
            <span>Developer Reference</span>
          </div>
          <h2 className="font-heading" style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', marginBottom: '12px' }}>
            Documentation & CLI Guide
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '700px', margin: '0 auto' }}>
            Clean commands, predictable exit codes, and zero configuration friction.
          </p>
        </div>

        {/* 2-Column Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '24px' }}>
          {/* CLI Commands Reference */}
          <div className="glass-panel glass-panel-cyan" style={{ padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
              <Terminal size={20} color="#00f2fe" />
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
                CLI Command Reference
              </h3>
            </div>

            {cliCommands.map((item, idx) => (
              <div
                key={idx}
                style={{
                  padding: '14px',
                  borderRadius: '10px',
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid rgba(0, 242, 254, 0.15)',
                  marginBottom: '14px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <code style={{ color: '#00f2fe', fontSize: '0.88rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    $ {item.cmd}
                  </code>
                  <button
                    onClick={() => copyText(item.cmd, `cmd-${idx}`)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                  >
                    {copiedCmd === `cmd-${idx}` ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                  </button>
                </div>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0 }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>

          {/* Security Allowlist & Exit Codes */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Allowlist Card */}
            <div className="glass-panel" style={{ padding: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
                <ShieldCheck size={20} color="#10b981" />
                <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>
                  Command Execution Allowlist
                </h4>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.5 }}>
                Any shell command proposed by the model must match this strict allowlist. Nothing else executes:
              </p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <span className="glass-pill glass-pill-emerald" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  npm install
                </span>
                <span className="glass-pill glass-pill-emerald" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  prisma generate
                </span>
                <span className="glass-pill glass-pill-emerald" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                  prisma migrate dev
                </span>
              </div>
            </div>

            {/* Exit Code Table */}
            <div className="glass-panel" style={{ padding: '24px' }}>
              <h4 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff', marginBottom: '14px' }}>
                Clean Scriptable Exit Codes
              </h4>
              {exitCodes.map((ec, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    padding: '10px 0',
                    borderBottom: idx < exitCodes.length - 1 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 800,
                      fontSize: '1rem',
                      color: ec.code === '0' ? '#10b981' : ec.code === '1' ? '#f59e0b' : '#f43f5e',
                      width: '24px',
                    }}
                  >
                    {ec.code}
                  </span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#fff' }}>{ec.meaning}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{ec.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
