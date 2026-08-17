import React, { useState } from 'react';
import { Network, FileCode, AlertTriangle, ShieldCheck, CheckCircle2, ArrowRight, Eye, ShieldAlert, Zap } from 'lucide-react';

interface SchemaMutation {
  id: string;
  name: string;
  target: string;
  change: string;
  affectedFilesCount: number;
  graphNodes: Array<{
    type: 'schema' | 'route' | 'component' | 'import';
    name: string;
    path: string;
    status: 'MUTATED' | 'UPDATED' | 'STALE_WARNING' | 'CLEAN';
  }>;
  ragResult: {
    outcome: 'SILENT_BREAK';
    writtenFiles: number;
    brokenFiles: string[];
    description: string;
  };
  graphytiResult: {
    outcome: 'DUAL_VERIFIED' | 'BLOCKED_SAFE';
    writtenFiles: number;
    description: string;
  };
}

const mutations: SchemaMutation[] = [
  {
    id: 'rename-email',
    name: 'Rename Field User.email → username',
    target: 'prisma/schema.prisma',
    change: 'Rename model property',
    affectedFilesCount: 4,
    graphNodes: [
      { type: 'schema', name: 'User.email', path: 'prisma/schema.prisma', status: 'MUTATED' },
      { type: 'route', name: 'GET /api/user/profile', path: 'app/api/user/profile/route.ts', status: 'UPDATED' },
      { type: 'component', name: '<UserProfileCard />', path: 'components/UserProfileCard.tsx', status: 'UPDATED' },
      { type: 'import', name: 'UserTypes.ts', path: 'types/user.ts', status: 'UPDATED' },
    ],
    ragResult: {
      outcome: 'SILENT_BREAK',
      writtenFiles: 1,
      brokenFiles: ['components/UserProfileCard.tsx', 'app/api/user/profile/route.ts'],
      description: 'RAG only retrieved similarity matches; missed 2 component references resulting in runtime TypeError in production.',
    },
    graphytiResult: {
      outcome: 'DUAL_VERIFIED',
      writtenFiles: 4,
      description: 'Graphyti walked the relation graph, computed blast radius, verified AST & HydraDB relations before writing.',
    },
  },
  {
    id: 'delete-authorId',
    name: 'Delete Field Post.authorId',
    target: 'prisma/schema.prisma',
    change: 'Breaking relation deletion',
    affectedFilesCount: 5,
    graphNodes: [
      { type: 'schema', name: 'Post.authorId', path: 'prisma/schema.prisma', status: 'MUTATED' },
      { type: 'route', name: 'GET /api/posts', path: 'app/api/posts/route.ts', status: 'STALE_WARNING' },
      { type: 'route', name: 'POST /api/posts/create', path: 'app/api/posts/create/route.ts', status: 'STALE_WARNING' },
      { type: 'component', name: '<AuthorBadge />', path: 'components/AuthorBadge.tsx', status: 'STALE_WARNING' },
      { type: 'import', name: 'postService.ts', path: 'lib/postService.ts', status: 'STALE_WARNING' },
    ],
    ragResult: {
      outcome: 'SILENT_BREAK',
      writtenFiles: 2,
      brokenFiles: ['app/api/posts/create/route.ts', 'components/AuthorBadge.tsx'],
      description: 'Standard AI deleted authorId in schema and postService, leaving broken components that failed on deployment.',
    },
    graphytiResult: {
      outcome: 'BLOCKED_SAFE',
      writtenFiles: 0,
      description: 'Stage 2 HydraDB graph verification detected 3 stale relations. Disk write blocked. 0 partial files written.',
    },
  },
  {
    id: 'add-priority',
    name: 'Add Field Post.priority Int',
    target: 'prisma/schema.prisma',
    change: 'Non-breaking schema extension',
    affectedFilesCount: 3,
    graphNodes: [
      { type: 'schema', name: 'Post.priority', path: 'prisma/schema.prisma', status: 'MUTATED' },
      { type: 'route', name: 'GET /api/posts', path: 'app/api/posts/route.ts', status: 'UPDATED' },
      { type: 'component', name: '<PostList />', path: 'components/PostList.tsx', status: 'UPDATED' },
    ],
    ragResult: {
      outcome: 'SILENT_BREAK',
      writtenFiles: 1,
      brokenFiles: ['components/PostList.tsx'],
      description: 'Model forgot to update the frontend render component.',
    },
    graphytiResult: {
      outcome: 'DUAL_VERIFIED',
      writtenFiles: 3,
      description: 'Both Stage 1 AST check and Stage 2 HydraDB check confirmed complete propagation.',
    },
  },
];

export const BlastRadiusSimulator: React.FC = () => {
  const [selectedMutationId, setSelectedMutationId] = useState<string>('rename-email');

  const mutation = mutations.find((m) => m.id === selectedMutationId) || mutations[0];

  return (
    <section id="blast-radius" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Section Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div className="glass-pill glass-pill-purple" style={{ marginBottom: '16px' }}>
            <Network size={14} color="#c084fc" />
            <span>Pre-Write Safety Engine</span>
          </div>
          <h2 className="font-heading" style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', marginBottom: '12px' }}>
            Pre-Write Blast Radius Calculation
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '750px', margin: '0 auto' }}>
            Before writing a single line to disk, Graphyti walks the codebase graph to answer:{' '}
            <strong style={{ color: '#00f2fe' }}>What actually breaks if we change this?</strong>
          </p>
        </div>

        {/* Mutation Selector Tabs */}
        <div
          style={{
            display: 'flex',
            gap: '12px',
            justifyContent: 'center',
            flexWrap: 'wrap',
            marginBottom: '32px',
          }}
        >
          {mutations.map((m) => {
            const isActive = m.id === selectedMutationId;
            return (
              <button
                key={m.id}
                onClick={() => setSelectedMutationId(m.id)}
                className={`glass-pill ${isActive ? 'glass-pill-cyan' : ''}`}
                style={{
                  padding: '10px 20px',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  background: isActive ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                  borderColor: isActive ? '#00f2fe' : 'rgba(255, 255, 255, 0.1)',
                  color: isActive ? '#00f2fe' : '#e2e8f0',
                }}
              >
                <span>{m.name}</span>
              </button>
            );
          })}
        </div>

        {/* Simulator Grid Layout */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '24px' }}>
          {/* Left Column: Computed Graph Blast Tree */}
          <div className="glass-panel glass-panel-cyan" style={{ padding: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Network size={20} color="#00f2fe" />
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
                  Computed Blast Tree
                </h3>
              </div>
              <span className="glass-pill glass-pill-cyan" style={{ fontSize: '0.75rem' }}>
                {mutation.affectedFilesCount} Files Affected
              </span>
            </div>

            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
              {mutation.graphNodes.map((node, index) => {
                let badgeColor = '#38bdf8';
                if (node.status === 'STALE_WARNING') badgeColor = '#f43f5e';
                if (node.status === 'MUTATED') badgeColor = '#00f2fe';
                if (node.status === 'UPDATED') badgeColor = '#10b981';

                return (
                  <div
                    key={index}
                    style={{
                      padding: '12px 14px',
                      borderRadius: '10px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                      marginBottom: '10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, color: '#fff', fontSize: '0.88rem' }}>{node.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{node.path}</div>
                    </div>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontWeight: 700,
                        background: `${badgeColor}20`,
                        color: badgeColor,
                        border: `1px solid ${badgeColor}40`,
                      }}
                    >
                      {node.status}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Comparative Safety Outcome */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Standard RAG Tool Box */}
            <div className="glass-panel" style={{ padding: '24px', borderColor: 'rgba(244, 63, 94, 0.3)', background: 'rgba(244, 63, 94, 0.03)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                <ShieldAlert size={20} color="#f43f5e" />
                <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#f43f5e' }}>
                  Traditional RAG / Embedding Coding Agent
                </h4>
              </div>
              <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '12px' }}>
                {mutation.ragResult.description}
              </p>
              <div style={{ fontSize: '0.8rem', color: '#f43f5e', fontFamily: 'var(--font-mono)' }}>
                ❌ Silent failure: Wrote {mutation.ragResult.writtenFiles} file, broke {mutation.ragResult.brokenFiles.length} dependent files on disk.
              </div>
            </div>

            {/* Graphyti Dual Verification Box */}
            <div className="glass-panel glass-panel-cyan" style={{ padding: '24px', background: 'rgba(0, 242, 254, 0.04)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                <ShieldCheck size={20} color="#00f2fe" />
                <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#00f2fe' }}>
                  Graphyti Coding Agent (Deterministic Graph)
                </h4>
              </div>
              <p style={{ fontSize: '0.88rem', color: '#e2e8f0', lineHeight: 1.5, marginBottom: '12px' }}>
                {mutation.graphytiResult.description}
              </p>
              <div style={{ fontSize: '0.82rem', color: '#10b981', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {mutation.graphytiResult.outcome === 'DUAL_VERIFIED'
                  ? `✅ DUAL VERIFIED: All ${mutation.graphytiResult.writtenFiles} files updated atomically.`
                  : '⛔ WRITE BLOCKED: Verification failed. 0 partial files written to disk.'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
