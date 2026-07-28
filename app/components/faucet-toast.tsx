interface FaucetToastProps {
  message: string | null;
  tone: "success" | "warning" | "error";
  actionUrl: string | null;
}

export function FaucetToast({
  message,
  tone,
  actionUrl,
}: FaucetToastProps) {
  if (!message) return null;

  return (
    <div
      className={`faucet-toast ${tone}`}
      role={tone === "success" ? "status" : "alert"}
    >
      <span>{message}</span>
      {actionUrl ? (
        <a href={actionUrl} target="_blank" rel="noreferrer">
          Get devnet SOL from Solana faucet
        </a>
      ) : null}
    </div>
  );
}
