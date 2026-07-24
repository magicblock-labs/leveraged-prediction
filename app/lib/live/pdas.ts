import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

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

export function userLiquidityPda(
  programId: PublicKey,
  user: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_liquidity"), user.toBuffer()],
    programId,
  )[0];
}

export function feeAuthorityPda(
  programId: PublicKey,
  market: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_authority"), market.toBuffer()],
    programId,
  )[0];
}

export function delegationBufferPda(
  programId: PublicKey,
  delegatedAccount: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buffer"), delegatedAccount.toBuffer()],
    programId,
  )[0];
}
