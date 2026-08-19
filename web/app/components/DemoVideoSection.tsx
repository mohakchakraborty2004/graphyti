'use client';

import { AnimatedBackground } from './AnimatedBackground';

const VIDEO_ID = '7pZtKeFzWSM';

type DemoVideoSectionProps = {
  videoId?: string;
};

export function DemoVideoSection({ videoId = VIDEO_ID }: DemoVideoSectionProps) {
  return (
    <section className="demo-video-section" id="demo">
      <div className="demo-video-bg">
        <AnimatedBackground
          density={0.5}
          speed={0.35}
          waveAmplitude={0.9}
          waveFrequency={0.025}
          glowRadius={130}
          enableHover
          restingColor={[0.14, 0.14, 0.14]}
          peakColor={[1.0, 0.42, 0.1]}
        />
      </div>
      <div className="demo-video-content">
        <span className="demo-label">SEE IT IN ACTION</span>
        <h2 className="demo-title">
          See it catch a <span className="cursive-orange">bad change</span>
        </h2>
        <p className="demo-subtitle">
          Graphyti walks the code graph, proposes a scoped edit, verifies it, and only then writes to disk.
        </p>
        <div className="demo-video-container">
          <div className="demo-video-frame">
            {videoId ? (
              <iframe
                src={`https://www.youtube.com/embed/${videoId}`}
                title="Graphyti demo"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              />
            ) : (
              <div className="video-placeholder">
                <div className="video-play-icon">▶</div>
                <span className="video-text">Demo video coming soon</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
