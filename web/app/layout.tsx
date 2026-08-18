import type { Metadata } from 'next';
import { Fira_Code, Newsreader, Space_Grotesk } from 'next/font/google';
import './globals.css';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';

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
  title: 'Graphyti — Code that verifies itself',
  description:
    'A CLI coding agent that builds a deterministic code graph and checks every AI-generated change against it before anything is written to disk.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${newsreader.variable} ${firaCode.variable}`}>
      <body>
        <Navbar />
        {children}
        <Footer />
      </body>
    </html>
  );
}
