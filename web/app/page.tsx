import { AsciiNoiseField } from './components/AsciiNoiseField';
import { StartButton } from './components/StartButton';
import { HowItWorksSection } from './components/HowItWorksSection';
import { DemoVideoSection } from './components/DemoVideoSection';
import { FeaturesSection } from './components/FeaturesSection';

const sidebarPanels = [
  {
    glyph: '∴',
    label: 'Verify',
    copy: 'Local parse and HydraDB must agree.',
  },
  {
    glyph: '⊕',
    label: 'Graph',
    copy: 'The codebase, as structure, not text.',
  },
  {
    glyph: '◈',
    label: 'Blast radius',
    copy: 'What breaks, named before the write.',
  },
];

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="Graphyti home">
      <LogoMark />
      <span>Graphyti</span>
    </a>
  );
}

export default function Home() {
  return (
    <main id="top" className="landing-shell">
      <div className="dot-grid" aria-hidden="true" />

      <header className="topbar">
        <Brand />
      </header>

      <section className="hero-stage" aria-label="Graphyti">
        <div className="hero-copy">
          <h1>
            Code that{' '}
            <span className="cursive-orange">verifies</span>
            <br />
            itself.
          </h1>
          <p className="subhead">
            Graphyti builds a real graph of your codebase and checks every AI-generated change against it before anything gets written.
          </p>
          <div className="cta-row">
            <a className="btn-pill-outlined" href="https://github.com/graphyti/graphyti">
              Build
            </a>
            <StartButton />
          </div>
        </div>

        <div className="ascii-wrap">
          <AsciiNoiseField />
        </div>

        <aside className="sidebar-panels" aria-label="Graphyti pillars">
          {sidebarPanels.map((panel) => (
            <section className="sidebar-panel" key={panel.label}>
              <span className="panel-glyph" aria-hidden="true">
                {panel.glyph}
              </span>
              <div>
                <h2>{panel.label}</h2>
                <p>{panel.copy}</p>
              </div>
            </section>
          ))}
        </aside>
      </section>

      <HowItWorksSection />

      <DemoVideoSection />

      <FeaturesSection />

      <section id="start" className="quickstart" aria-label="Quickstart">
        <span>Install</span>
        <code>npx graphyti</code>
      </section>

      <footer className="site-footer">
        <Brand />
        <nav aria-label="Footer">
          <a href="https://github.com/graphyti/graphyti">Open Source</a>
          <a href="https://www.typescriptlang.org/">TypeScript</a>
          <a href="https://hydradb.com">HydraDB</a>
        </nav>
        <a className="social-link" href="https://github.com/graphyti">
          @graphyti
        </a>
        <div className="legal-links">
          <a href="#top">Privacy Policy</a>
          <a href="#top">Terms of Use</a>
        </div>
      </footer>
    </main>
  );
}
