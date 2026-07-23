import { Buffer } from "buffer";

export function installBrowserBuffer(): void {
  globalThis.Buffer = Buffer;
}

installBrowserBuffer();
