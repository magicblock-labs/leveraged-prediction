export interface DelegationStatus {
  isDelegated: boolean;
  fqdn?: string;
  delegationRecord?: {
    authority: string;
    owner: string;
    delegationSlot: number;
    lamports: number;
  };
}

export async function getDelegationStatus(
  routerEndpoint: string,
  account: string,
): Promise<DelegationStatus> {
  const response = await fetch(
    `${routerEndpoint.replace(/\/+$/, "")}/getDelegationStatus`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `delegation-${account}`,
        method: "getDelegationStatus",
        params: [account],
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Router returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    result?: DelegationStatus;
    error?: { message?: string };
  };
  if (body.error || !body.result) {
    throw new Error(body.error?.message ?? "Router response had no result");
  }
  if (body.result.isDelegated && !body.result.fqdn) {
    const endpoint = new URL(routerEndpoint);
    if (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost") {
      return { ...body.result, fqdn: endpoint.origin };
    }
  }
  return body.result;
}

export function normalizeErEndpoint(fqdn: string): string {
  const endpoint = fqdn.startsWith("http") ? fqdn : `https://${fqdn}`;
  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}
