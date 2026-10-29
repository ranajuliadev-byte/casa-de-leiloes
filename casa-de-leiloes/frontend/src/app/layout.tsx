import type { Metadata, Viewport } from 'next';
import { Fraunces, Manrope } from 'next/font/google';
import { Providers } from '@/components/providers';
import { Header } from '@/components/header';
import './globals.css';

const fraunces = Fraunces({
  variable: '--font-fraunces',
  subsets: ['latin'],
  axes: ['opsz'],
  style: ['normal', 'italic'],
  display: 'swap',
});

const manrope = Manrope({
  variable: '--font-manrope',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'Casa de Leilões', template: '%s · Casa de Leilões' },
  description: 'Leilões online de obras de arte com lances ao vivo, carteira e histórico auditável.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f3ee' },
    { media: '(prefers-color-scheme: dark)', color: '#18191b' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body className={`${fraunces.variable} ${manrope.variable} min-h-dvh antialiased`}>
        <Providers>
          <Header />
          <main id="conteudo" className="pb-24">
            {children}
          </main>
          <footer className="no-print border-t border-rule">
            <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted sm:flex-row sm:justify-between sm:px-6 lg:px-8">
              <p>Casa de Leilões. Obras do acervo público do Art Institute of Chicago.</p>
              <p>Todo histórico de lances pode ser auditado publicamente.</p>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
