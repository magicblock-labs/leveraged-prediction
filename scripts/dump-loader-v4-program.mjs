import { writeFile } from "node:fs/promises";
import { Connection, PublicKey } from "@solana/web3.js";

const [, , endpoint, addressValue, outputPath] = process.argv;
if (!endpoint || !addressValue || !outputPath) {
  throw new Error("usage: dump-loader-v4-program.mjs <rpc> <program-id> <output>");
}

const LOADER_V4 = new PublicKey("LoaderV411111111111111111111111111111111111");
const LOADER_V4_HEADER_LENGTH = 48;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const address = new PublicKey(addressValue);
const connection = new Connection(endpoint, "confirmed");
const account = await connection.getAccountInfo(address, "confirmed");

if (!account?.executable || !account.owner.equals(LOADER_V4)) {
  throw new Error(`${address.toBase58()} is not an executable Loader v4 program`);
}
const program = Buffer.from(account.data).subarray(LOADER_V4_HEADER_LENGTH);
if (program.length === 0 || !program.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC)) {
  throw new Error(`${address.toBase58()} does not contain an ELF at the Loader v4 offset`);
}

await writeFile(outputPath, program, { mode: 0o755 });
console.log(`Wrote ${program.length} program bytes for ${address.toBase58()}`);
