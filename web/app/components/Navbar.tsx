'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function Navbar() {
  const pathname = usePathname();

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <Link className="brand" href="/" aria-label="Graphyti home">
          <LogoMark />
          <span>Graphyti</span>
        </Link>

        <nav className="navbar-links" aria-label="Main">
          <Link
            href="/docs"
            className={`navbar-link ${pathname === '/docs' ? 'active' : ''}`}
          >
            Documentation
          </Link>
          <Link
            href="/about"
            className={`navbar-link ${pathname === '/about' ? 'active' : ''}`}
          >
            About
          </Link>
        </nav>

        <div className="navbar-right">
          <span className="navbar-handle">@graphyti</span>
          <a
            className="navbar-social"
            href="https://twitter.com/I_Mohak19"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Mohak on Twitter"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <span>Mohak</span>
          </a>
          <a
            className="navbar-social"
            href="https://twitter.com/onirbanhere"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Anirban on Twitter"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <span>Anirban</span>
          </a>
        </div>
      </div>
    </header>
  );
}
