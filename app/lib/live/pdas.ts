import { PublicKey } from "@solana/web3.js";

export function protocolConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    programId,
  )[0];
}

export function marketPda(programId: PublicKey, marketId: number): PublicKey {
  const marketIdBytes = Buffer.alloc(2);
  marketIdBytes.writeUInt16LE(marketId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), marketIdBytes],
    programId,
  )[0];
}

export function userPositionsPda(
  programId: PublicKey,
  user: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_positions"), user.toBuffer()],
    programId,
  )[0];
}
