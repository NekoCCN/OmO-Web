export function readWindowsPasswordFile(path: string): Promise<Buffer>;
export function createWindowsPasswordFile(path: string, password: string): Promise<void>;
