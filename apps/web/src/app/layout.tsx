import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/instrument-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'Phoenix Platform', template: '%s · Phoenix' },
  description: 'Leads, admissions, software sales and onboarding for every Phoenix company.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#11162E',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
