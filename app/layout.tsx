import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Price Rush",
  description: "Ten-second directional price plays powered by MagicBlock",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
