import type { ReactNode } from "react";
import { Inter, Outfit } from "next/font/google";
import "./globals.css";
import { RegisterSW } from "@/components/flix/RegisterSW";

// Two build-time, self-hosted faces (next/font emits woff2 into the bundle, so
// no runtime Google CDN call — satisfies the strict `font-src 'self'` CSP).
// Inter drives body/UI copy (tall x-height, tabular-nums for timecodes and
// upload speeds); Outfit is the display face for hero titles, the FLIX
// wordmark, section headings and stat numerals.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap" });

export const metadata = {
  title: "Flix — Ta vidéothèque personnelle",
  description: "Flix est une plateforme vidéo self-hosted 100% locale : confidentialité totale, zéro télémétrie, lecture entièrement hors-ligne.",
  applicationName: "Flix",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent" as const,
    title: "Flix",
  },
};

export const viewport = {
  themeColor: "#141414",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="fr" suppressHydrationWarning className={`dark ${inter.variable} ${outfit.variable}`}>
      <body className="bg-background text-foreground font-sans antialiased">
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
