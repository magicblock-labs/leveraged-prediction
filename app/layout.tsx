import type { Metadata } from "next";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import { SolanaProvider } from "@/app/providers/solana-provider";

export const metadata: Metadata = {
  title: "Price Rush",
  description: "Ten-second directional price plays powered by MagicBlock",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><SolanaProvider>{children}</SolanaProvider></body>
    </html>
  );
}
