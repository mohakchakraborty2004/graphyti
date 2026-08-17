import React from 'react';
import { Rocket, Sparkles, MessageSquare, Cloud, ArrowUpRight } from 'lucide-react';

export const RoadmapSection: React.FC = () => {
  const items = [
    {
      title: 'Plan & Create Mode',
      status: 'IN PROGRESS',
      description: 'Decomposing broad requests ("add a login feature") into an ordered sequence of independently-verified structural steps, including net-new file creation.',
      icon: Sparkles,
      color: '#00f2fe',
    },
    {
      title: 'Persistent Terminal Chat',
      status: 'IN PROGRESS',
      description: 'A long-lived conversational session (à la Claude Code/OpenCode) layered on top of the same verified pipeline, ensuring code changes go through full blast-radius verification.',
      icon: MessageSquare,
      color: '#c084fc',
    },
    {
      title: 'Hosted Mode (Supabase + HydraDB)',
      status: 'PLANNED',
      description: 'Account-based setup where users bring their own OpenRouter key and get a scoped HydraDB-backed graph, with credentials held server-side only.',
      icon: Cloud,
      color: '#10b981',
    },
  ];

  return (
    <section id="roadmap" style={{ padding: '60px 24px', position: 'relative' }}>
      <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div className="glass-pill glass-pill-purple" style={{ marginBottom: '16px' }}>
            <Rocket size={14} color="#c084fc" />
            <span>Future Vision</span>
          </div>
          <h2 className="font-heading" style={{ fontSize: '2.5rem', fontWeight: 800, color: '#fff', marginBottom: '12px' }}>
            What's Next for Graphyti
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', maxWidth: '700px', margin: '0 auto' }}>
            Extending deterministic verification to high-level feature planning, multi-turn chat, and cloud org graphs.
          </p>
        </div>

        {/* 3 Grid Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
          {items.map((item, idx) => {
            const Icon = item.icon;
            return (
              <div
                key={idx}
                className="glass-panel"
                style={{
                  padding: '28px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                    <div
                      style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '10px',
                        background: `${item.color}15`,
                        border: `1px solid ${item.color}40`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon size={20} color={item.color} />
                    </div>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        padding: '3px 8px',
                        borderRadius: '9999px',
                        fontWeight: 700,
                        background: `${item.color}20`,
                        color: item.color,
                        border: `1px solid ${item.color}40`,
                      }}
                    >
                      {item.status}
                    </span>
                  </div>

                  <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#fff', marginBottom: '8px' }}>
                    {item.title}
                  </h3>

                  <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    {item.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
