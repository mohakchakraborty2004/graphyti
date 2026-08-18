'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, RefreshCw, CheckCircle2, AlertTriangle, ShieldCheck, Copy, Check } from 'lucide-react';

interface TerminalScenario {
  id: string;
  name: string;
  command: string;
  status: 'SUCCESS' | 'DRY_RUN' | 'VERIFICATION_BLOCKED';
  logs: Array<{ type: string; text: string }>;
}

const scenarios: TerminalScenario[] = [
  {
    id: 'rename-field',
    name: 'Rename Schema Field',
    command: 'graphyti "rename Post.title to headline"',
    status: 'SUCCESS',
    logs: [
      { type: 'info', text: '🚀 Graphyti CLI v1.0.0 initializing...' },
      { type: 'extract', text: '🔍 Static Parser: Analyzing Prisma schema & TypeScript AST via ts-morph...' },
      { type: 'extract', text: '📊 HydraDB Knowledge Record loaded (42 nodes, 89 edges)' },
      { type: 'blast', text: '💥 Pre-write Blast Radius calculated:' },
      { type: 'blast', text: '   ├── prisma/schema.prisma (model Post: field title)' },
      { type: 'blast', text: '   ├── app/api/posts/route.ts (GET query selecting title)' },
      { type: 'blast', text: '   └── components/PostCard.tsx (rendering post.title prop)' },
      { type: 'stage1', text: '🧪 Stage 1 Local Check: Re-parsing modified AST with ts-morph...' },
      { type: 'stage1', text: '   ✅ Stage 1 Passed: 3/3 target AST references updated cleanly' },
      { type: 'stage2', text: '🔮 Stage 2 HydraDB Check: Staging graph delta & cross-checking relation graph...' },
      { type: 'stage2', text: '   ✅ Stage 2 Passed: 0 orphaned nodes or broken edge relations' },
      { type: 'success', text: '✨ SUCCESS: Both verification layers passed. 3 files written to disk cleanly (Exit Code 0).' },
    ],
  },
  {
    id: 'dry-run',
    name: 'Dry Run Mode',
    command: 'graphyti "add priority field to Post" --dry-run',
    status: 'DRY_RUN',
    logs: [
      { type: 'info', text: '🚀 Graphyti CLI v1.0.0 --dry-run active' },
      { type: 'extract', text: '🔍 Parsing codebase graph (Prisma + Next.js App Router)...' },
      { type: 'blast', text: '💥 Dry Run Blast Radius calculation:' },
      { type: 'blast', text: '   ├── prisma/schema.prisma (+ priority Int @default(0))' },
      { type: 'blast', text: '   └── app/api/posts/route.ts (add optional filter)' },
      { type: 'stage1', text: '🧪 Simulated Stage 1 Verification: Clean' },
      { type: 'stage2', text: '🔮 Simulated Stage 2 HydraDB Verification: Clean' },
      { type: 'warning', text: '🛡️  DRY RUN COMPLETE: Zero files modified on disk. Safe preview verified (Exit Code 0).' },
    ],
  },
  {
    id: 'verification-blocked',
    name: 'Verification Guard Block',
    command: 'graphyti "delete User.email"',
    status: 'VERIFICATION_BLOCKED',
    logs: [
      { type: 'info', text: '🚀 Graphyti CLI v1.0.0 starting structural update...' },
      { type: 'extract', text: '🔍 Static Parser: Analyzing `delete User.email`...' },
      { type: 'blast', text: '💥 Pre-write Blast Radius detected breaking changes across 4 files!' },
      { type: 'stage1', text: '🧪 Stage 1 Local Check: Re-parsing modified AST...' },
      { type: 'stage1', text: '   ⚠️  Stage 1 Warning: app/api/auth/session/route.ts still references User.email' },
      { type: 'stage2', text: '🔮 Stage 2 HydraDB Check: Checking relation graph for stale edges...' },
      { type: 'stage2', text: '   ❌ Stage 2 Failed: Orphaned node `User.email` linked by `SessionComponent.tsx`' },
      { type: 'warning', text: '🔄 Bounded retry 1/1: Feeding gap details back to model...' },
      { type: 'error', text: '⛔ HARD WRITE BLOCK: Verification failed. Graphyti wrote NOTHING to disk.' },
      { type: 'error', text: '   Zero partial files created. Codebase remains 100% clean (Exit Code 1).' },
    ],
  },
];

export const InteractiveTerminal: React.FC = () => {
  const [activeScenarioId, setActiveScenarioId] = useState<string>('rename-field');
  const [outputLogs, setOutputLogs] = useState<Array<{ type: string; text: string }>>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [mode, setMode] = useState<'tui' | 'json'>('tui');
  const [copied, setCopied] = useState<boolean>(false);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const scenario = scenarios.find((s) => s.id === activeScenarioId) || scenarios[0];

  const runScenario = (scen: TerminalScenario) => {
    setIsRunning(true);
    setOutputLogs([]);

    scen.logs.forEach((log, index) => {
      setTimeout(() => {
        setOutputLogs((prev) => [...prev, log]);
        if (index === scen.logs.length - 1) {
          setIsRunning(false);
        }
      }, (index + 1) * 350);
    });
  };

  useEffect(() => {
    runScenario(scenario);
  }, [activeScenarioId]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [outputLogs]);

  const copyCmd = () => {
    navigator.clipboard.writeText(scenario.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="terminal" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        {/* Section Header */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // INTERACTIVE CLI RUNTIME
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5' }}>
            CLI Sandbox & Dual Verification Stream
          </h2>
        </div>

        {/* Command Selector Buttons */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '24px' }}>
          {scenarios.map((scen) => {
            const isActive = scen.id === activeScenarioId;
            return (
              <button
                key={scen.id}
                onClick={() => setActiveScenarioId(scen.id)}
                style={{
                  padding: '10px 18px',
                  borderRadius: '4px',
                  border: isActive ? '1px solid #ff6a1a' : '1px solid #2a2a2a',
                  background: isActive ? 'rgba(255, 106, 26, 0.08)' : '#0d0d0d',
                  color: isActive ? '#ff6a1a' : '#8a8a8a',
                  fontSize: '0.85rem',
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                {scen.status === 'SUCCESS' && <CheckCircle2 size={14} color="#10b981" />}
                {scen.status === 'DRY_RUN' && <ShieldCheck size={14} color="#38bdf8" />}
                {scen.status === 'VERIFICATION_BLOCKED' && <AlertTriangle size={14} color="#f43f5e" />}
                <span>{scen.name}</span>
              </button>
            );
          })}
        </div>

        {/* Terminal Window Box */}
        <div style={{ border: '1px solid #2a2a2a', borderRadius: '4px', background: '#050505', overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ padding: '12px 20px', background: '#0d0d0d', borderBottom: '1px solid #2a2a2a', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#f43f5e' }}></span>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#eab308' }}></span>
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#10b981' }}></span>
              <span style={{ marginLeft: '12px', fontSize: '0.8rem', color: '#8a8a8a', fontFamily: 'var(--font-mono)' }}>
                bash — graphyti CLI runtime v1.0.0
              </span>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setMode('tui')}
                style={{
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  border: mode === 'tui' ? '1px solid #ff6a1a' : '1px solid #2a2a2a',
                  background: mode === 'tui' ? 'rgba(255,106,26,0.1)' : 'transparent',
                  color: mode === 'tui' ? '#ff6a1a' : '#8a8a8a',
                  borderRadius: '2px',
                  cursor: 'pointer',
                }}
              >
                TUI Log
              </button>
              <button
                onClick={() => setMode('json')}
                style={{
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  border: mode === 'json' ? '1px solid #ff6a1a' : '1px solid #2a2a2a',
                  background: mode === 'json' ? 'rgba(255,106,26,0.1)' : 'transparent',
                  color: mode === 'json' ? '#ff6a1a' : '#8a8a8a',
                  borderRadius: '2px',
                  cursor: 'pointer',
                }}
              >
                --json
              </button>
            </div>
          </div>

          {/* Prompt Bar */}
          <div style={{ padding: '12px 20px', background: '#0a0a0a', borderBottom: '1px solid #1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>
              <span style={{ color: '#ff6a1a', fontWeight: 700 }}>$</span>
              <span style={{ color: '#f5f5f5' }}>{scenario.command}</span>
            </div>
            <button onClick={copyCmd} style={{ background: 'transparent', border: 'none', color: '#8a8a8a', cursor: 'pointer' }}>
              {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '20px', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', lineHeight: 1.6, maxHeight: '420px', overflowY: 'auto' }}>
            {mode === 'tui' ? (
              <div>
                {outputLogs.map((log, i) => {
                  let color = '#f5f5f5';
                  if (log.type === 'extract') color = '#38bdf8';
                  if (log.type === 'blast') color = '#ff6a1a';
                  if (log.type === 'stage1') color = '#38bdf8';
                  if (log.type === 'stage2') color = '#c084fc';
                  if (log.type === 'success') color = '#10b981';
                  if (log.type === 'warning') color = '#eab308';
                  if (log.type === 'error') color = '#f43f5e';

                  return (
                    <div key={i} style={{ color, marginBottom: '4px' }}>
                      {log.text}
                    </div>
                  );
                })}
              </div>
            ) : (
              <pre style={{ color: '#ff6a1a', fontSize: '0.8rem' }}>
                {JSON.stringify({ timestamp: new Date().toISOString(), scenario: scenario.id, command: scenario.command, logs: outputLogs.map(l => l.text) }, null, 2)}
              </pre>
            )}
            <div ref={terminalEndRef} />
          </div>
        </div>
      </div>
    </section>
  );
};
