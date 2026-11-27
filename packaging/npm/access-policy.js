export const passwordPattern = /^[\x20-\x7e]{1,128}$/;
export const recommendedPasswordLength = 20;

export function parseProxyOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? url : undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
}
