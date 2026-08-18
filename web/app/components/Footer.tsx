'use client';

import Link from 'next/link';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Link className="brand" href="/" aria-label="Graphyti home">
            <span className="logo-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Graphyti</span>
          </Link>
          <span className="footer-handle">@graphyti</span>
        </div>

        <nav className="footer-nav" aria-label="Footer">
          <Link href="/docs">Documentation</Link>
          <Link href="/about">About</Link>
          <a href="https://github.com/mohakchakraborty2004/graphyti" target="_blank" rel="noopener noreferrer">Open Source</a>
          <a href="https://www.typescriptlang.org/" target="_blank" rel="noopener noreferrer">TypeScript</a>
          <a href="https://hydradb.com" target="_blank" rel="noopener noreferrer">HydraDB</a>
        </nav>

        <div className="footer-socials">
          <a
            className="footer-social"
            href="https://twitter.com/I_Mohak19"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Mohak on Twitter"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <span>@I_Mohak19</span>
          </a>
          <a
            className="footer-social"
            href="https://twitter.com/onirbanhere"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Anirban on Twitter"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <span>@onirbanhere</span>
          </a>
        </div>

        <div className="footer-legal">
          <a href="#top">Privacy Policy</a>
          <a href="#top">Terms of Use</a>
        </div>
      </div>
    </footer>
  );
}
