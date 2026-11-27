export const loopbackAddress: "127.0.0.1";
export const wildcardAddress: "0.0.0.0";
export function interfaceAddresses(): readonly { readonly name: string; readonly address: string; readonly cidr: string | null }[];
export function isRemoteAddress(host: string | undefined): boolean;
