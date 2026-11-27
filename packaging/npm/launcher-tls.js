import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { cliTr } from "./locale.js";
import { createWindowsPrivateFile } from "./windows-password.js";

const run = promisify(execFile);

export function certificateOrigin(input, port) {
  const host = input.trim().toLowerCase();
  const family = isIP(host);
  if (host === "0.0.0.0" || (family !== 4 &&
      (family !== 0 || host.length > 253 || /^[\d.]+$/.test(host) || host.split(".")
        .some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))) {
    throw new Error(cliTr("请输入浏览器使用的 IPv4 地址或 DNS 名（不含端口）。",
      "Enter the browser's IPv4 address or DNS name, without a port."));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(cliTr("生成 HTTPS 证书需要固定端口（OMO_WEB_PORT）。",
      "HTTPS generation requires a fixed port (OMO_WEB_PORT)."));
  }
  const url = new URL(`https://${host}:${port}`);
  if (url.hostname !== host) throw new Error(cliTr("请输入规范的 IPv4 地址或 DNS 名。",
    "Enter a canonical IPv4 address or DNS name."));
  return { url, san: `${family === 4 ? "IP" : "DNS"}:${host}` };
}

export async function generateCertificate(settings, input, port) {
  const { url, san } = certificateOrigin(input, port);
  const folder = await mkdtemp(join(await settings.prepare(), "tls-"));
  const certFile = join(folder, "cert.pem");
  const keyFile = join(folder, "key.pem");
  const configuration = join(folder, "openssl.cnf");
  let saved = false;
  try {
    // A fixed request config avoids inheriting a machine's CA extensions.
    await writeFile(configuration, "[req]\ndistinguished_name = dn\n[dn]\n", { flag: "wx", mode: 0o600 });
    let output;
    try {
      ({ stdout: output } = await run("openssl", [
        "req", "-config", configuration, "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-nodes", "-days", "90", "-subj", "/CN=OmO Web", "-addext", `subjectAltName=${san}`,
        "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth",
        "-out", "-", "-keyout", "-",
      ], { env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" }, timeout: 8000, maxBuffer: 16384, windowsHide: true }));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error(error.code === "ENOENT"
        ? cliTr("找不到 OpenSSL。请安装 OpenSSL 1.1.1+ 并加入 PATH。", "Install OpenSSL 1.1.1+ and add it to PATH.")
        : cliTr("OpenSSL 生成证书失败。请检查 OpenSSL 安装和版本。", "OpenSSL could not generate the certificate. Check its installation and version."));
    }
    const cert = output.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u)?.[0];
    const key = output.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/u)?.[0];
    if (!cert || !key) throw new Error(cliTr("OpenSSL 未返回完整的证书和私钥。", "OpenSSL did not return a certificate and private key."));
    await writeFile(certFile, `${cert}\n`, { flag: "wx", mode: 0o644 });
    if (process.platform === "win32") await createWindowsPrivateFile(keyFile, Buffer.from(`${key}\n`));
    else await writeFile(keyFile, `${key}\n`, { flag: "wx", mode: 0o600 });
    await rm(configuration);
    await settings.enableGeneratedTls({ origin: url.origin, certFile, keyFile });
    saved = true;
    return certFile;
  } finally {
    if (!saved) await rm(folder, { force: true, recursive: true });
  }
}
