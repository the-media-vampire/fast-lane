import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./studio.css";

const serif = localFont({ src: [{ path: "./fonts/instrument-serif-latin.woff2", weight: "400", style: "normal" }, { path: "./fonts/instrument-serif-italic-latin.woff2", weight: "400", style: "italic" }], variable: "--font-serif", display: "swap" });
const sans = localFont({ src: "./fonts/inter-latin.woff2", weight: "100 900", variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Fast Lane",
  description: "From an idea to a finished 30-second to two-minute film.",
};

export const viewport: Viewport = { themeColor: "#101112", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
