import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About — Graphyti',
  description: 'Read the story behind Graphyti — how a deterministic code graph eliminates AI\'s structural hallucination problem.',
};

export default function AboutPage() {
  return (
    <main className="about-page">
      <article className="about-content">
        <div className="about-meta">
          <span className="about-tag">ARTICLE</span>
          <span className="about-date">2025</span>
        </div>

        <h1 className="about-title">
          Graphyti: How a <span className="cursive-orange">Deterministic Code Graph</span> Eliminates AI&apos;s Structural Hallucination Problem
        </h1>

        <div className="about-authors">
          <span>Built and written by</span>
          <a href="https://twitter.com/I_Mohak19" target="_blank" rel="noopener noreferrer" className="about-author">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            @I_Mohak19
          </a>
          <a href="https://twitter.com/onirbanhere" target="_blank" rel="noopener noreferrer" className="about-author">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
            @onirbanhere
          </a>
        </div>

        <div className="about-body">
          <h2>The $2B Problem Nobody Talks About</h2>
          <p>
            Every AI coding tool — Cursor, Copilot, Aider, all of them — has a dirty secret. They don&apos;t just hallucinate facts about the world. They hallucinate the shape of <em>your own codebase</em>.
          </p>
          <p>
            The model invents a field that doesn&apos;t exist on a <span className="orange">Prisma</span> model. It forgets a relation it created two prompts ago. It renames something without knowing three other files depend on it. It &quot;helpfully&quot; restructures code nobody asked it to touch.
          </p>
          <p>
            This isn&apos;t regular hallucination. It&apos;s <strong>structural hallucination</strong> — and it&apos;s the silent killer of AI coding tools.
          </p>

          <h2>Why Existing Solutions Fall Short</h2>
          <p>
            The industry&apos;s answer has been better context retrieval. Embeddings. Repo maps. <span className="orange">RAG</span> pipelines that fetch smarter context before feeding it to the model.
          </p>
          <p>
            That helps. But it only makes the model&apos;s <em>input</em> better. It does nothing to verify the model&apos;s <em>output</em>.
          </p>
          <p>
            You can give the model a perfect picture of your codebase. It still might get the output wrong. And if you trust that output without verification, you&apos;re one bad generation away from a partial write that silently breaks production.
          </p>

          <h2>Enter Graphyti</h2>
          <p>
            <span className="orange">Graphyti</span> is a CLI coding agent built on a different core claim: <strong>the model never has to be trusted to remember your codebase correctly, because a deterministic code graph checks its work before anything is written to disk.</strong>
          </p>
          <p>
            The key insight: the graph is used twice. Once to ground generation (smarter context), and again, independently, to verify the result before it&apos;s trusted.
          </p>

          <h2>How It Works</h2>

          <h3>Step 1: Deterministic Extraction</h3>
          <p>
            A static parser — <span className="orange">Prisma</span> schema parser + <span className="orange">TypeScript</span> AST analysis via ts-morph, never an LLM guess — builds a graph of your codebase. Models. Fields. API routes. Components. And the real edges between them: which route queries which model, which component renders which field, which file imports which.
          </p>
          <p>
            No LLM guessing. No embedding similarity. Just deterministic parsing.
          </p>

          <h3>Step 2: Scoped, Structured Edits</h3>
          <p>
            The LLM never rewrites whole files. It first proposes a narrow, structured operation — something like <code>rename_field User.name {'->'} username</code> — which gets applied as a deterministic edit. A targeted schema mutation. A search/replace snippet the model must anchor to the exact current file content.
          </p>
          <p>
            This alone eliminates an entire class of bugs. The model physically cannot silently delete or restructure code it wasn&apos;t asked to touch, because the edit mechanism doesn&apos;t give it the surface area to do so.
          </p>

          <h3>Step 3: Blast Radius, Computed Before Anything Is Written</h3>
          <p>
            Before applying a breaking change, <span className="orange">Graphyti</span> walks the graph to answer: <em>what actually depends on this?</em>
          </p>
          <p>
            Which routes query this model? Which components render this field? Which files would silently break?
          </p>
          <p>
            You see this before a single file is written. Not after.
          </p>

          <h3>Step 4: Two Independent Verification Layers</h3>
          <p>
            This is where <span className="orange">Graphyti</span> diverges from everything else on the market.
          </p>
          <p>
            <strong>Local structural check:</strong> After generation, the same deterministic parser re-parses the <em>generated</em> content and confirms every file in the blast radius was genuinely addressed — not just touched.
          </p>
          <p>
            <strong><span className="orange">HydraDB</span> graph check:</strong> The generated change is also re-ingested into HydraDB and cross-checked against the graph&apos;s own stored relations. This catches a failure class local parsing can&apos;t see: stale or orphaned graph nodes left behind by an incomplete update.
          </p>
          <p>
            Both must agree before anything is written. If either fails, <span className="orange">Graphyti</span> retries once with the specific gap called out. If that still fails, it writes <strong>nothing</strong> and tells you exactly what&apos;s unresolved.
          </p>
          <p>
            No partial writes. No silent completions. No &quot;it looks like it worked&quot; when it didn&apos;t.
          </p>

          <h3>Step 5: A Real Safety Boundary on Execution</h3>
          <p>
            Any shell command the agent wants to run — <code>npm install</code>, <code>prisma generate</code>, <code>prisma migrate dev</code> — is matched against a strict allowlist and shown to you before it runs. Nothing outside that allowlist executes, ever, regardless of what the model proposes.
          </p>

          <h2>The Verification Flow in Action</h2>
          <p>
            Here&apos;s what happens when you run <code>graphyti &quot;remove the bio field from the User model&quot;</code>:
          </p>
          <ol>
            <li><span className="orange">Context retrieval</span> pulls the graph context from HydraDB</li>
            <li><span className="orange">Classification</span> determines this is a single-step operation</li>
            <li><span className="orange">Intent extraction</span> produces <code>remove_field on User.bio</code></li>
            <li><span className="orange">Code generation</span> creates the schema edit + migration commands</li>
            <li><span className="orange">Blast radius</span> identifies 4 affected files: 2 API routes, 2 components</li>
            <li><span className="orange">Re-generation</span> attempts to update affected files</li>
            <li><span className="orange">Structural verification</span> checks if all blast-radius files were properly updated</li>
            <li>If verification passes, write proceeds and graph index updates</li>
            <li>If verification fails, one retry, then clean failure, nothing written</li>
          </ol>
          <p>
            The verification is the critical gate. It&apos;s not a suggestion. It&apos;s a hard boundary.
          </p>

          <h2>Why This Is Different</h2>
          <div className="about-table-wrap">
            <table className="about-table">
              <thead>
                <tr>
                  <th></th>
                  <th>RAG-only tools</th>
                  <th><span className="orange">Graphyti</span></th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Context retrieval</td>
                  <td>Similarity search</td>
                  <td><span className="orange">Graph traversal</span> + hybrid search</td>
                </tr>
                <tr>
                  <td>Edit mechanism</td>
                  <td>Full-file regeneration</td>
                  <td><span className="orange">Scoped structural edits</span> only</td>
                </tr>
                <tr>
                  <td>Pre-write safety check</td>
                  <td>None, or model self-report</td>
                  <td><span className="orange">Blast radius</span> computed from the graph</td>
                </tr>
                <tr>
                  <td>Post-generation verification</td>
                  <td>None (trust the output)</td>
                  <td><span className="orange">Two independent checks</span>: local re-parse + graph cross-check</td>
                </tr>
                <tr>
                  <td>Failure behavior</td>
                  <td>Writes whatever was generated</td>
                  <td><span className="orange">Blocks the write</span> entirely if verification fails</td>
                </tr>
                <tr>
                  <td>Shell command execution</td>
                  <td>Often unrestricted</td>
                  <td><span className="orange">Strict allowlist</span> + explicit confirmation</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2>The Tech Stack</h2>
          <ul>
            <li><strong>CLI:</strong> <span className="orange">TypeScript</span>, Commander, Ora/Chalk for terminal UX</li>
            <li><strong>Static analysis:</strong> ts-morph (<span className="orange">TypeScript</span> AST), dedicated <span className="orange">Prisma</span> schema parser</li>
            <li><strong>Graph store:</strong> <span className="orange">HydraDB</span> — knowledge ingestion, forceful relations, hybrid graph-aware retrieval</li>
            <li><strong>LLM:</strong> <span className="orange">OpenRouter</span> (model-agnostic, no hardcoded provider dependency)</li>
            <li><strong>Target stack:</strong> <span className="orange">Next.js</span> (App Router + Pages Router) + <span className="orange">Prisma</span></li>
          </ul>

          <h2>Safety by Design</h2>
          <p>
            Every design decision in <span className="orange">Graphyti</span> is motivated by the same principle: <strong>never trust the model&apos;s output without verification.</strong>
          </p>
          <ul>
            <li><span className="orange">Blast radius confirmation</span> — breaking changes shown with reasons before you&apos;re asked to confirm</li>
            <li><span className="orange">Two-layer verification</span> — nothing writes unless both the local parser and the independent graph check agree</li>
            <li><span className="orange">One bounded retry</span> — a verification miss gets one automatic retry; a second miss is a hard, clean failure</li>
            <li><span className="orange">Command allowlist</span> — only approved shell commands can ever execute</li>
            <li><span className="orange">Clean exit codes</span> — 0 success, 1 verification blocked, 2 unexpected error — safe for CI and scripts</li>
          </ul>

          <h2>What&apos;s Next</h2>
          <p>
            <span className="orange">Graphyti&apos;s</span> core pipeline — extraction, scoped edits, blast radius, dual verification — is live and working. Actively in progress:
          </p>
          <ul>
            <li><span className="orange">Plan &amp; Create mode</span> — decomposing broad requests into ordered, independently-verified structural steps, including net-new file creation</li>
            <li><span className="orange">Persistent terminal chat mode</span> — a long-lived conversational session layered on the same verified pipeline</li>
            <li><span className="orange">Hosted mode</span> — account-based setup where users bring their own OpenRouter key</li>
          </ul>

          <h2>The Bottom Line</h2>
          <p>
            Most AI coding tools trust the model. <span className="orange">Graphyti</span> verifies it.
          </p>
          <p>
            That&apos;s not a feature. It&apos;s a safety boundary. And in a world where AI coding agents are increasingly trusted with production codebases, it&apos;s the difference between &quot;it probably works&quot; and &quot;we know it works.&quot;
          </p>

          <div className="about-cta">
            <p><span className="orange">Graphyti</span> is open source under the MIT license. Try it:</p>
            <div className="about-code-block">
              <code># Point Graphyti at your project<br />graphyti init-graph<br /><br /># Make a scoped, verified change<br />graphyti &quot;rename Post.title to headline&quot;<br /><br /># Preview without writing anything<br />graphyti &quot;add a priority field to Post&quot; --dry-run</code>
            </div>
          </div>
        </div>
      </article>
    </main>
  );
}
