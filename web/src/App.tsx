import React from 'react';
import { Header } from '../app/components/Header';
import { HeroSection } from '../app/components/HeroSection';
import { InteractiveTerminal } from '../app/components/InteractiveTerminal';
import { BlastRadiusSimulator } from '../app/components/BlastRadiusSimulator';
import { CodeGraphVisualizer } from '../app/components/CodeGraphVisualizer';
import { ArchitectureFlow } from '../app/components/ArchitectureFlow';
import { HydraDBSection } from '../app/components/HydraDBSection';
import { ComparisonMatrix } from '../app/components/ComparisonMatrix';
import { DocsAndCli } from '../app/components/DocsAndCli';
import { RoadmapSection } from '../app/components/RoadmapSection';
import { Footer } from '../app/components/Footer';
import '../app/globals.css';

export function App() {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#f5f5f5', position: 'relative' }}>
      <Header />
      <main>
        <HeroSection
          onScrollToTerminal={() => scrollTo('terminal')}
          onScrollToBlastRadius={() => scrollTo('blast-radius')}
        />
        <InteractiveTerminal />
        <BlastRadiusSimulator />
        <CodeGraphVisualizer />
        <ArchitectureFlow />
        <HydraDBSection />
        <ComparisonMatrix />
        <DocsAndCli />
        <RoadmapSection />
      </main>
      <Footer />
    </div>
  );
}

export default App;
