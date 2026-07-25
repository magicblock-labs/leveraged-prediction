import Link from "next/link";

export function BrandMark() {
  return (
    <Link className="brand-mark" href="/" aria-label="Lever home">
      <svg
        className="brand-icon"
        viewBox="0 0 32 32"
        role="img"
        aria-hidden="true"
      >
        <rect x="1" y="1" width="30" height="30" rx="9" />
        <path d="M7.5 20.5 24.5 11" />
        <path d="m12.5 25 3.5-6 3.5 6Z" />
      </svg>
      <span className="brand-wordmark">lever</span>
    </Link>
  );
}
