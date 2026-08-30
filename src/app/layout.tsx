import type { Metadata } from "next";
import { Nunito, Roboto } from "next/font/google";
import "./globals.css";

// Kiowa Design System font roles: Nunito for brand/display/headings,
// Roboto for product UI/body (the M3 type scale). Self-hosted via
// next/font rather than the design system's own Google Fonts CDN
// @import, matching how this app already loaded its previous fonts.
const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
});

const roboto = Roboto({
  variable: "--font-roboto",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

// Deliberately price-free: the price on the page is read from billing config
// at request time, and a number hardcoded here would be the one thing that
// silently drifts away from what the payment QR actually asks for.
const TAGLINE =
  "Set up your own AI voice agent in minutes. Your customers get a number to call, " +
  "answered day or night, in English or their own language. No demo, no sales call.";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.mybizcare.com"),
  title: "MyBizCare - AI that answers your business calls",
  description: TAGLINE,
  openGraph: {
    title: "MyBizCare - AI that answers your business calls",
    description: TAGLINE,
    url: "/",
    siteName: "MyBizCare",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "MyBizCare - AI that answers your business calls",
    description: TAGLINE,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${nunito.variable} ${roboto.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Material Symbols - the icon system every Kiowa component uses.
            A plain CSS @import url() for this got silently dropped by the
            build's CSS bundler (Lightning CSS resolves/inlines @import at
            build time and doesn't preserve unresolved remote ones), so it's
            loaded as a real <link> here instead - React hoists rel=
            stylesheet links to <head> regardless of where they render. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400,0,0&display=swap"
        />
        {children}
      </body>
    </html>
  );
}
