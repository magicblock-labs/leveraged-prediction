import type { Metadata } from "next";
import { LiquidityPage } from "@/app/components/liquidity-page";

export const metadata: Metadata = {
  title: "Liquidity · Lever",
  description: "Add or remove liquidity from the Lever prediction market",
};

export default function Page() {
  return <LiquidityPage />;
}
