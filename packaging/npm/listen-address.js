import { networkInterfaces } from "node:os";

export const loopbackAddress = "127.0.0.1";
export const wildcardAddress = "0.0.0.0";

export function interfaceAddresses() {
  const entries = new Map();
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.family === "IPv4" && !item.internal && !entries.has(item.address)) {
        entries.set(item.address, { name, address: item.address, cidr: item.cidr });
      }
    }
  }
  return [...entries.values()];
}

export function isRemoteAddress(host) {
  return host !== undefined && host !== loopbackAddress;
}
