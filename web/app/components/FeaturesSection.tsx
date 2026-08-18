'use client';

import { AnimatedBackground } from './AnimatedBackground';
import { FeatureRow } from './FeatureRow';
import { FeatureGraph3D } from './FeatureGraph3D';
import { BlastAnimation } from './BlastAnimation';
import { EditAnimation } from './EditAnimation';
import { CommandTypewriter } from './CommandTypewriter';

const FEATURES = [
  {
    title: 'Two-layer verification',
    description: [
      'Local AST re-parse confirms every file in the blast radius was addressed.',
      'HydraDB graph cross-check catches stale nodes local parsing cannot see.',
      'Both must agree before anything is written to disk.',
    ],
    visualization: <FeatureGraph3D />,
    side: 'left' as const,
  },
  {
    title: 'Blast radius calculation',
    description: [
      'Walks the code graph before anything is written.',
      'Shows which routes, components, and files depend on what you are changing.',
      'You see the full impact before confirming.',
    ],
    visualization: <BlastAnimation />,
    side: 'right' as const,
  },
  {
    title: 'Scoped edits',
    description: [
      'The model proposes a narrow, structured operation.',
      'Applied as a targeted mutation — not full-file regeneration.',
      'Zero surface area for silent deletions.',
    ],
    visualization: <EditAnimation />,
    side: 'left' as const,
  },
  {
    title: 'Command allowlist',
    description: [
      'Only approved shell commands can ever execute.',
      'npm install, prisma generate, prisma migrate dev — that is it.',
      'Nothing outside that list runs, regardless of what the model proposes.',
    ],
    visualization: <CommandTypewriter />,
    side: 'right' as const,
  },
];

export function FeaturesSection() {
  return (
    <section className="features-section" id="features">
      <div className="features-bg">
        <AnimatedBackground
          density={0.35}
          speed={0.15}
          waveAmplitude={0.3}
          waveFrequency={0.02}
          glowRadius={100}
          enableHover
          restingColor={[0.12, 0.12, 0.12]}
          peakColor={[0.6, 0.28, 0.06]}
        />
      </div>
      <div className="features-content">
        <span className="features-label">WHY GRAPHYTI</span>
        <h2 className="features-title">
          Built different. <span className="cursive-orange">Verified.</span>
        </h2>
        <div className="features-rows">
          {FEATURES.map((feature, i) => (
            <FeatureRow
              key={feature.title}
              title={feature.title}
              description={feature.description}
              visualization={feature.visualization}
              side={feature.side}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
