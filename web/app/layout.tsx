import type { Metadata } from 'next';
import { Fira_Code, Newsreader, Space_Grotesk } from 'next/font/google';
import './globals.css';

const spaceGrotesk = Space_Grotesk({
  weight: ['500', '600', '700'],
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const newsreader = Newsreader({
  weight: ['300', '400'],
  style: ['italic'],
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
});

const firaCode = Fira_Code({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Graphyti - Structure you can trust, not guess',
  description: "A CLI coding agent that builds a deterministic code graph and verifies every AI-generated structural change before writing to disk.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${newsreader.variable} ${firaCode.variable}`}>
      <body>{children}</body>
    </html>
  );
}
