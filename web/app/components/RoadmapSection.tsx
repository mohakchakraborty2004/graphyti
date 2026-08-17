'use client';

import React from 'react';
import { Rocket, Sparkles, MessageSquare, Cloud } from 'lucide-react';

export const RoadmapSection: React.FC = () => {
  const items = [
    { title: 'Plan & Create Mode', status: 'IN PROGRESS', desc: 'Decomposing broad requests ("add login feature") into verified structural steps with net-new file creation.', icon: Sparkles },
    { title: 'Persistent Terminal Chat', status: 'IN PROGRESS', desc: 'Long-lived conversational session (à la Claude Code/OpenCode) layered on top of verified pipeline.', icon: MessageSquare },
    { title: 'Hosted Mode (Supabase + HydraDB)', status: 'PLANNED', desc: 'Account-based setup where users bring OpenRouter keys and get scoped org graph stores.', icon: Cloud },
  ];

  return (
    <section id="roadmap" style={{ padding: '60px 32px', background: '#0a0a0a', borderTop: '1px solid #2a2a2a' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        <div style={{ marginBottom: '32px' }}>
          <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '8px' }}>
            // ROADMAP & FUTURE VISION
          </div>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontSize: '2.2rem', fontWeight: 800, color: '#f5f5f5' }}>
            What's Next for Graphyti
          </h2>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <div key={i} style={{ border: '1px solid #2a2a2a', background: '#0d0d0d', padding: '24px', borderRadius: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <Icon size={18} color="#ff6a1a" />
                  <span style={{ fontSize: '0.7rem', padding: '2px 8px', border: '1px solid #ff6a1a', color: '#ff6a1a', fontFamily: 'var(--font-mono)' }}>
                    {item.status}
                  </span>
                </div>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f5f5f5', marginBottom: '8px' }}>{item.title}</h3>
                <p style={{ fontSize: '0.82rem', color: '#8a8a8a', lineHeight: 1.5, margin: 0 }}>{item.desc}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};
