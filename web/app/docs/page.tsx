import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Documentation — Graphyti',
  description: 'Learn how to set up and use Graphyti, the CLI coding agent that verifies AI-generated changes against a deterministic code graph.',
};

export default function DocsPage() {
  return (
    <main className="docs-page">
      <div className="docs-content">
        <h1 className="docs-title">
          Getting Started with <span className="cursive-orange">Graphyti</span>
        </h1>
        <p className="docs-intro">
          Graphyti is a CLI coding agent that builds a <span className="orange">deterministic code graph</span> of your project and checks every AI-generated change against it before anything is written to disk.
        </p>

        <section className="docs-section">
          <h2>Prerequisites</h2>
          <ul>
            <li><span className="orange">Node.js</span> 18 or later</li>
            <li>A <span className="orange">Next.js</span> project (App Router or Pages Router)</li>
            <li><span className="orange">Prisma</span> as your ORM</li>
            <li>An <span className="orange">OpenRouter</span> API key for LLM access</li>
          </ul>
        </section>

        <section className="docs-section">
          <h2>Installation</h2>
          <p>Install Graphyti globally or run it directly with npx:</p>
          <div className="docs-code-block">
            <code>npx graphyti</code>
          </div>
          <p>Or install globally:</p>
          <div className="docs-code-block">
            <code>npm install -g graphyti</code>
          </div>
        </section>

        <section className="docs-section">
          <h2>Setup</h2>
          <p>Initialize the <span className="orange">code graph</span> for your project:</p>
          <div className="docs-code-block">
            <code>graphyti init-graph</code>
          </div>
          <p>This scans your project and builds a <span className="orange">deterministic graph</span> of your models, fields, routes, components, and their relationships. The graph is stored in <span className="orange">HydraDB</span> for fast retrieval.</p>
        </section>

        <section className="docs-section">
          <h2>Usage</h2>
          <p>Make <span className="orange">scoped, verified changes</span> to your codebase:</p>
          <div className="docs-code-block">
            <code>graphyti &quot;rename Post.title to headline&quot;</code>
          </div>
          <p>Preview changes without writing anything:</p>
          <div className="docs-code-block">
            <code>graphyti &quot;add a priority field to Post&quot; --dry-run</code>
          </div>
          <p>Remove a field:</p>
          <div className="docs-code-block">
            <code>graphyti &quot;remove the bio field from the User model&quot;</code>
          </div>
        </section>

        <section className="docs-section">
          <h2>How It Works</h2>
          <div className="docs-steps">
            <div className="docs-step">
              <span className="docs-step-num">1</span>
              <div>
                <h3><span className="orange">Deterministic Extraction</span></h3>
                <p>A static parser (Prisma schema parser + TypeScript AST via ts-morph) builds a graph of your codebase. No LLM guessing. No embedding similarity.</p>
              </div>
            </div>
            <div className="docs-step">
              <span className="docs-step-num">2</span>
              <div>
                <h3><span className="orange">Scoped, Structured Edits</span></h3>
                <p>The LLM never rewrites whole files. It proposes narrow operations like <code>rename_field User.name {'->'} username</code> applied as deterministic edits.</p>
              </div>
            </div>
            <div className="docs-step">
              <span className="docs-step-num">3</span>
              <div>
                <h3><span className="orange">Blast Radius</span></h3>
                <p>Before applying a breaking change, Graphyti walks the graph to show what depends on what you are changing.</p>
              </div>
            </div>
            <div className="docs-step">
              <span className="docs-step-num">4</span>
              <div>
                <h3><span className="orange">Two-Layer Verification</span></h3>
                <p>Local re-parse + HydraDB graph cross-check. Both must agree before anything writes to disk.</p>
              </div>
            </div>
            <div className="docs-step">
              <span className="docs-step-num">5</span>
              <div>
                <h3><span className="orange">Command Allowlist</span></h3>
                <p>Only approved shell commands execute: <code>npm install</code>, <code>prisma generate</code>, <code>prisma migrate dev</code>. Nothing else.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="docs-section">
          <h2>The Verification Flow</h2>
          <p>When you run a command like <code>graphyti &quot;remove the bio field from the User model&quot;</code>:</p>
          <ol>
            <li><span className="orange">Context retrieval</span> pulls graph context from HydraDB</li>
            <li><span className="orange">Classification</span> determines this is a single-step operation</li>
            <li><span className="orange">Intent extraction</span> produces <code>remove_field on User.bio</code></li>
            <li><span className="orange">Code generation</span> creates the schema edit + migration commands</li>
            <li><span className="orange">Blast radius</span> identifies affected files: API routes, components</li>
            <li><span className="orange">Re-generation</span> attempts to update affected files</li>
            <li><span className="orange">Structural verification</span> checks if all blast-radius files were properly updated</li>
            <li>If verification passes, write proceeds and graph index updates</li>
            <li>If verification fails, one retry, then clean failure with nothing written</li>
          </ol>
        </section>

        <section className="docs-section">
          <h2>Safety Features</h2>
          <ul>
            <li><span className="orange">Blast radius confirmation</span> — breaking changes shown with reasons before you confirm</li>
            <li><span className="orange">Two-layer verification</span> — nothing writes unless both checks agree</li>
            <li><span className="orange">One bounded retry</span> — a verification miss gets one retry; second miss is a hard failure</li>
            <li><span className="orange">Command allowlist</span> — only approved shell commands execute</li>
            <li><span className="orange">Clean exit codes</span> — 0 success, 1 verification blocked, 2 unexpected error</li>
          </ul>
        </section>

        <section className="docs-section">
          <h2>Target Stack</h2>
          <p>Graphyti currently supports:</p>
          <ul>
            <li><span className="orange">Next.js</span> (App Router + Pages Router)</li>
            <li><span className="orange">Prisma</span> ORM</li>
            <li><span className="orange">TypeScript</span></li>
          </ul>
          <p>LLM access is provided via <span className="orange">OpenRouter</span>, which supports model-agnostic access without hardcoded provider dependencies.</p>
        </section>

        <section className="docs-section">
          <h2>Open Source</h2>
          <p>Graphyti is open source under the MIT license.</p>
          <div className="docs-code-block">
            <code>https://github.com/mohakchakraborty2004/graphyti</code>
          </div>
        </section>
      </div>
    </main>
  );
}
