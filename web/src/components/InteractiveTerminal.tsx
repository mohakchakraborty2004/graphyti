import React, { useState, useEffect, useRef } from 'react';
import { Terminal as TerminalIcon, Play, RefreshCw, CheckCircle2, AlertTriangle, ShieldCheck, Database, Code, Check, Copy } from 'lucide-react';

interface TerminalScenario {
  id: string;
  name: string;
  command: string;
  description: string;
  status: 'SUCCESS' | 'DRY_RUN' | 'VERIFICATION_BLOCKED';
  logs: Array<{
    type: 'info' | 'extract' | 'blast' | 'stage1' | 'stage2' | 'success' | 'warning' | 'error';
    text: string;
    delay?: number;
  }>;
}

const scenarios: TerminalScenario[] = [
  {
    id: 'rename-field',
    name: 'Rename Schema Field',
    command: 'graphyti "rename Post.title to headline"',
    description: 'Renames a Prisma field and safely propagates through dependent API routes & React components.',
    status: 'SUCCESS',
    logs: [
      { type: 'info', text: '🚀 Graphyti CLI v1.0.0 initializing...' },
      { type: 'extract', text: '🔍 Static Parser: Analyzing Prisma schema & TypeScript AST via ts-morph...' },
      { type: 'extract', text: '📊 HydraDB Knowledge Record loaded (42 nodes, 89 edges)' },
      { type: 'blast', text: '💥 Computing Pre-write Blast Radius for `rename Post.title → headline`:' },
      { type: 'blast', text: '   ├── prisma/schema.prisma (model Post: field title)' },
      { type: 'blast', text: '   ├── app/api/posts/route.ts (GET query selecting title)' },
      { type: 'blast', text: '   └── components/PostCard.tsx (rendering post.title prop)' },
      { type: 'info', text: '⚡ Applying scoped structural edit operation...' },
      { type: 'stage1', text: '🧪 Stage 1 Local Check: Re-parsing modified AST files with ts-morph...' },
      { type: 'stage1', text: '   ✅ Stage 1 Passed: 3/3 target AST references updated cleanly' },
      { type: 'stage2', text: '🔮 Stage 2 HydraDB Check: Staging graph delta & cross-checking relation graph...' },
      { type: 'stage2', text: '   ✅ Stage 2 Passed: 0 orphaned nodes or broken edge relations detected' },
      { type: 'success', text: '✨ SUCCESS: Both verification layers passed. 3 files written to disk cleanly (Exit Code 0).' },
    ],
  },
  {
    id: 'dry-run',
    name: 'Dry Run Mode',
    command: 'graphyti "add priority field to Post" --dry-run',
    description: 'Previews the proposed changes and blast radius with zero side effects or disk modifications.',
    status: 'DRY_RUN',
    logs: [
      { type: 'info', text: '🚀 Graphyti CLI v1.0.0 --dry-run mode active' },
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
    description: 'Catches an incomplete field deletion that would silently break 2 API routes, blocking writes.',
    status: 'VERIFICATION_BLOCKED',
    logs: [
      { type: 'info', text: '🚀 Graphyti CLI v1.0.0 starting structural update...' },
      { type: 'extract', text: '🔍 Static Parser: Analyzing `delete User.email`...' },
      { type: 'blast', text: '💥 Pre-write Blast Radius detected breaking changes across 4 files!' },
      { type: 'info', text: '⚡ Proposing scoped edit and running dual verification...' },
      { type: 'stage1', text: '🧪 Stage 1 Local Check: Re-parsing modified AST...' },
      { type: 'stage1', text: '   ⚠️  Stage 1 Warning: app/api/auth/session/route.ts still references User.email' },
      { type: 'stage2', text: '🔮 Stage 2 HydraDB Check: Checking relation graph for stale edges...' },
      { type: 'stage2', text: '   ❌ Stage 2 Failed: Orphaned node `User.email` linked by `SessionComponent.tsx`' },
      { type: 'warning', text: '🔄 Bounded retry 1/1: Feeding exact gap details back to model...' },
      { type: 'stage2', text: '   ❌ Retry Verification Failed: Code gap unresolved.' },
      { type: 'error', text: '⛔ HARD WRITE BLOCK: Verification failed. Graphyti wrote NOTHING to disk.' },
      { type: 'error', text: '   Zero partial files created. Your codebase remains 100% clean (Exit Code 1).' },
    ],
  },
  {
    id: 'graph-init',
    name: 'Graph Init',
    command: 'graphyti graph init',
    description: 'Scans full codebase, extracts AST nodes, and builds the HydraDB ground truth knowledge graph.',
    status: 'SUCCESS',
    logs: [
      { type: 'info', text: '🚀 Graphyti CLI v1.0.0 initializing codebase graph...' },
      { type: 'extract', text: '📦 Found Prisma Schema at `prisma/schema.prisma`' },
      { type: 'extract', text: '⚙️ Parsing AST for 18 TypeScript source files...' },
      { type: 'extract', text: '🌐 Extracted Nodes: 12 Models, 48 Fields, 8 API Routes, 14 React Components' },
      { type: 'stage2', text: '🔮 Ingesting knowledge records into HydraDB with forceful relations...' },
      { type: 'success', text: '✅ Graph initialization complete! HydraDB store synced (Exit Code 0).' },
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

  const runTerminalScenario = (scen: TerminalScenario) => {
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
    runTerminalScenario(scenario);
  }, [activeScenarioId]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [outputLogs]);

  const copyCommand = () => {
    navigator.clipboard.writeText(scenario.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section id="terminal" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Section Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div className="glass-pill glass-pill-cyan" style={{ marginBottom: '16px' }}>
            <TerminalIcon size={14} color="#00f2fe" />
            <span>Interactive CLI Simulator</span>
          </div>
          <h2 className="font-heading" style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', marginBottom: '12px' }}>
            See Dual Verification in Action
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '700px', margin: '0 auto' }}>
            Select a CLI command below to watch Graphyti extract AST structure, calculate blast radius, run dual checks, and protect your codebase.
          </p>
        </div>

        {/* Scenario Selectors Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '12px',
            marginBottom: '24px',
          }}
        >
          {scenarios.map((scen) => {
            const isActive = scen.id === activeScenarioId;
            return (
              <button
                key={scen.id}
                onClick={() => setActiveScenarioId(scen.id)}
                className={`glass-panel ${isActive ? 'glass-panel-cyan' : ''}`}
                style={{
                  padding: '16px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: isActive ? 'rgba(0, 242, 254, 0.06)' : 'var(--bg-card)',
                  borderColor: isActive ? 'rgba(0, 242, 254, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, color: isActive ? '#00f2fe' : '#e2e8f0' }}>
                    {scen.name}
                  </span>
                  {scen.status === 'SUCCESS' && <CheckCircle2 size={16} color="#10b981" />}
                  {scen.status === 'DRY_RUN' && <ShieldCheck size={16} color="#38bdf8" />}
                  {scen.status === 'VERIFICATION_BLOCKED' && <AlertTriangle size={16} color="#f43f5e" />}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {scen.command}
                </div>
              </button>
            );
          })}
        </div>

        {/* Terminal Window Container */}
        <div className="terminal-window">
          {/* Window Header */}
          <div className="terminal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="terminal-dot terminal-dot-red"></span>
              <span className="terminal-dot terminal-dot-yellow"></span>
              <span className="terminal-dot terminal-dot-green"></span>
              <span style={{ marginLeft: '12px', fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                bash — graphyti CLI runtime v1.0.0
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {/* Output Mode Switcher */}
              <div style={{ display: 'flex', background: 'rgba(0,0,0,0.4)', borderRadius: '6px', padding: '2px' }}>
                <button
                  onClick={() => setMode('tui')}
                  style={{
                    padding: '4px 10px',
                    fontSize: '0.75rem',
                    borderRadius: '4px',
                    background: mode === 'tui' ? 'rgba(0, 242, 254, 0.2)' : 'transparent',
                    color: mode === 'tui' ? '#00f2fe' : 'var(--text-muted)',
                    border: 'none',
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
                    borderRadius: '4px',
                    background: mode === 'json' ? 'rgba(168, 85, 247, 0.2)' : 'transparent',
                    color: mode === 'json' ? '#c084fc' : 'var(--text-muted)',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  --json Mode
                </button>
              </div>

              {/* Rerun Button */}
              <button
                onClick={() => runTerminalScenario(scenario)}
                disabled={isRunning}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  color: '#fff',
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.75rem',
                }}
              >
                <RefreshCw size={12} className={isRunning ? 'spin' : ''} />
                <span>Re-run</span>
              </button>
            </div>
          </div>

          {/* Command Prompt Input Bar */}
          <div
            style={{
              padding: '12px 20px',
              background: 'rgba(0, 0, 0, 0.4)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%' }}>
              <span style={{ color: '#00f2fe', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>$</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: '#fff', fontSize: '0.92rem' }}>
                {scenario.command}
              </span>
            </div>
            <button
              onClick={copyCommand}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '4px',
              }}
              title="Copy Command"
            >
              {copied ? <Check size={16} color="#10b981" /> : <Copy size={16} />}
            </button>
          </div>

          {/* Terminal Body */}
          <div className="terminal-body">
            {mode === 'tui' ? (
              <div>
                {outputLogs.map((log, index) => {
                  let color = '#e2e8f0';
                  if (log.type === 'extract') color = '#38bdf8';
                  if (log.type === 'blast') color = '#c084fc';
                  if (log.type === 'stage1') color = '#00f2fe';
                  if (log.type === 'stage2') color = '#a855f7';
                  if (log.type === 'success') color = '#34d399';
                  if (log.type === 'warning') color = '#fbbf24';
                  if (log.type === 'error') color = '#f43f5e';

                  return (
                    <div key={index} style={{ color, marginBottom: '6px', whiteSpace: 'pre-wrap' }}>
                      {log.text}
                    </div>
                  );
                })}

                {isRunning && (
                  <div style={{ color: '#00f2fe', display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' }}>
                    <span style={{ display: 'inline-block', width: '8px', height: '16px', background: '#00f2fe', animation: 'blink 1s infinite' }}></span>
                    <span>Processing Graph & Verification...</span>
                  </div>
                )}
              </div>
            ) : (
              <pre style={{ color: '#38bdf8', fontSize: '0.82rem' }}>
                {JSON.stringify(
                  {
                    timestamp: new Date().toISOString(),
                    scenario: scenario.id,
                    command: scenario.command,
                    status: scenario.status,
                    verification: {
                      stage1_local_ast: scenario.status !== 'VERIFICATION_BLOCKED',
                      stage2_hydradb_graph: scenario.status !== 'VERIFICATION_BLOCKED',
                    },
                    logs: outputLogs.map((l) => l.text),
                  },
                  null,
                  2
                )}
              </pre>
            )}
            <div ref={terminalEndRef} />
          </div>
        </div>
      </div>
    </section>
  );
};
