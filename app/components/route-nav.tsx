import Link from "next/link";

export function RouteNav({ active }: { active: "trade" | "liquidity" }) {
  return (
    <nav className="route-nav" aria-label="Primary">
      <Link href="/" aria-current={active === "trade" ? "page" : undefined}>
        Trade
      </Link>
      <Link
        href="/liquidity"
        aria-current={active === "liquidity" ? "page" : undefined}
      >
        Liquidity
      </Link>
    </nav>
  );
}
