import React, { useState } from 'react';
import { Network, Database, Code, FileText, Layers, Info, Filter } from 'lucide-react';

interface GraphNode {
  id: string;
  name: string;
  category: 'model' | 'route' | 'component' | 'hydradb';
  fieldsOrProps: string[];
  relations: string[];
  x: number;
  y: number;
}

const initialNodes: GraphNode[] = [
  {
    id: 'user-model',
    name: 'User (Prisma Model)',
    category: 'model',
    fieldsOrProps: ['id: String @id', 'email: String @unique', 'name: String', 'posts: Post[]'],
    relations: ['post-model', 'route-user-profile', 'component-user-card'],
    x: 180,
    y: 120,
  },
  {
    id: 'post-model',
    name: 'Post (Prisma Model)',
    category: 'model',
    fieldsOrProps: ['id: String @id', 'title: String', 'content: String', 'authorId: String'],
    relations: ['user-model', 'route-posts', 'component-post-card'],
    x: 480,
    y: 120,
  },
  {
    id: 'route-posts',
    name: 'GET /api/posts',
    category: 'route',
    fieldsOrProps: ['prisma.post.findMany()', 'select: { title, author }'],
    relations: ['post-model', 'component-post-card'],
    x: 680,
    y: 280,
  },
  {
    id: 'route-user-profile',
    name: 'GET /api/user/profile',
    category: 'route',
    fieldsOrProps: ['prisma.user.findUnique()', 'select: { email, name }'],
    relations: ['user-model', 'component-user-card'],
    x: 180,
    y: 320,
  },
  {
    id: 'component-post-card',
    name: '<PostCard />',
    category: 'component',
    fieldsOrProps: ['renders post.title', 'renders author.name'],
    relations: ['route-posts'],
    x: 520,
    y: 440,
  },
  {
    id: 'component-user-card',
    name: '<UserProfileCard />',
    category: 'component',
    fieldsOrProps: ['renders user.email', 'renders user.name'],
    relations: ['route-user-profile'],
    x: 180,
    y: 480,
  },
  {
    id: 'hydradb-sync',
    name: 'HydraDB Staged Graph',
    category: 'hydradb',
    fieldsOrProps: ['Forceful Relations Store', 'Orphaned Node Verification'],
    relations: ['user-model', 'post-model', 'route-posts', 'route-user-profile'],
    x: 400,
    y: 280,
  },
];

export const CodeGraphVisualizer: React.FC = () => {
  const [selectedNodeId, setSelectedNodeId] = useState<string>('post-model');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const selectedNode = initialNodes.find((n) => n.id === selectedNodeId) || initialNodes[0];

  const filteredNodes = categoryFilter === 'all' 
    ? initialNodes 
    : initialNodes.filter((n) => n.category === categoryFilter);

  return (
    <section id="graph" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div className="glass-pill glass-pill-cyan" style={{ marginBottom: '16px' }}>
            <Network size={14} color="#00f2fe" />
            <span>AST & HydraDB Store Visualizer</span>
          </div>
          <h2 className="font-heading" style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', marginBottom: '12px' }}>
            Deterministic Codebase Graph
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '750px', margin: '0 auto' }}>
            Extracted via static analysis (<code style={{ color: '#00f2fe' }}>ts-morph</code> + Prisma parser) and stored in HydraDB with explicit forceful edges.
          </p>
        </div>

        {/* Graph Controls */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '20px',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Filter size={16} color="var(--text-muted)" />
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Filter View:</span>
            {['all', 'model', 'route', 'component', 'hydradb'].map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                style={{
                  background: categoryFilter === cat ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                  border: categoryFilter === cat ? '1px solid #00f2fe' : '1px solid rgba(255, 255, 255, 0.08)',
                  color: categoryFilter === cat ? '#00f2fe' : 'var(--text-muted)',
                  padding: '4px 12px',
                  borderRadius: '9999px',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', gap: '16px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8' }}></span> Models
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#a855f7' }}></span> API Routes
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#10b981' }}></span> Components
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#00f2fe' }}></span> HydraDB Store
            </span>
          </div>
        </div>

        {/* Visualizer Panel Container */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 2fr) minmax(280px, 1fr)', gap: '24px' }}>
          {/* SVG Canvas */}
          <div
            className="glass-panel"
            style={{
              height: '520px',
              position: 'relative',
              overflow: 'hidden',
              background: 'rgba(8, 11, 18, 0.85)',
            }}
          >
            <svg style={{ width: '100%', height: '100%' }}>
              <defs>
                <linearGradient id="edgeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#00f2fe" stopOpacity="0.6" />
                  <stop offset="100%" stopColor="#a855f7" stopOpacity="0.6" />
                </linearGradient>
              </defs>

              {/* Render Relation Edges */}
              {filteredNodes.map((node) =>
                node.relations.map((relId) => {
                  const target = initialNodes.find((n) => n.id === relId);
                  if (!target) return null;
                  const isSelected = selectedNode.id === node.id || selectedNode.id === target.id;

                  return (
                    <line
                      key={`${node.id}-${target.id}`}
                      x1={node.x}
                      y1={node.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={isSelected ? '#00f2fe' : 'rgba(255, 255, 255, 0.12)'}
                      strokeWidth={isSelected ? 2.5 : 1}
                      strokeDasharray={isSelected ? '5,5' : 'none'}
                    />
                  );
                })
              )}

              {/* Render Graph Nodes */}
              {filteredNodes.map((node) => {
                const isSelected = node.id === selectedNode.id;
                let color = '#38bdf8';
                if (node.category === 'route') color = '#a855f7';
                if (node.category === 'component') color = '#10b981';
                if (node.category === 'hydradb') color = '#00f2fe';

                return (
                  <g
                    key={node.id}
                    onClick={() => setSelectedNodeId(node.id)}
                    style={{ cursor: 'pointer' }}
                    transform={`translate(${node.x}, ${node.y})`}
                  >
                    <circle
                      r={isSelected ? 26 : 20}
                      fill="rgba(15, 20, 32, 0.9)"
                      stroke={color}
                      strokeWidth={isSelected ? 3 : 1.5}
                      style={{
                        transition: 'all 0.3s ease',
                        filter: isSelected ? `drop-shadow(0 0 12px ${color})` : 'none',
                      }}
                    />
                    <text
                      textAnchor="middle"
                      dy="4"
                      fill="#fff"
                      fontSize="10"
                      fontWeight="700"
                      fontFamily="var(--font-mono)"
                    >
                      {node.name.slice(0, 6)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Node Metadata Inspector */}
          <div className="glass-panel glass-panel-cyan" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
              <Info size={18} color="#00f2fe" />
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>
                Graph Inspector
              </h3>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#00f2fe', marginBottom: '4px' }}>
                {selectedNode.name}
              </div>
              <span className="glass-pill glass-pill-purple" style={{ fontSize: '0.72rem' }}>
                Category: {selectedNode.category.toUpperCase()}
              </span>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>
                Fields / AST AST Properties:
              </h4>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '8px' }}>
                {selectedNode.fieldsOrProps.map((f, i) => (
                  <div key={i} style={{ color: '#e2e8f0', marginBottom: '4px' }}>• {f}</div>
                ))}
              </div>
            </div>

            <div>
              <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>
                Connected Edges ({selectedNode.relations.length}):
              </h4>
              {selectedNode.relations.map((relId) => {
                const target = initialNodes.find((n) => n.id === relId);
                return (
                  <div
                    key={relId}
                    onClick={() => setSelectedNodeId(relId)}
                    style={{
                      padding: '8px 12px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '6px',
                      fontSize: '0.8rem',
                      color: '#38bdf8',
                      marginBottom: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    → {target ? target.name : relId}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
