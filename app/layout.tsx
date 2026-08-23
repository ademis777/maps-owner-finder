import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Maps Owner Finder",
  description: "Resolve a Google Maps business and find public owner information.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
