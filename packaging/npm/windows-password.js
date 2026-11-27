import { execFile } from "node:child_process";
import { join, resolve } from "node:path";

const identity = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:OMO_WEB_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sidType = [System.Security.Principal.SecurityIdentifier]
`;

function powershell(script, path, input = "") {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(`${identity}\n${script}`, "utf16le").toString("base64");
  return new Promise((accept, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: { ...process.env, OMO_WEB_ACL_PATH: resolve(path) }, encoding: "buffer", timeout: 8000,
      maxBuffer: 4096, windowsHide: true,
    }, (error, bytes) => {
      if (error) reject(new Error("Windows password file or its ACL could not be verified."));
      else accept(bytes);
    });
    child.stdin?.on("error", reject);
    child.stdin?.end(input);
  });
}

export function readWindowsPasswordFile(path) {
  return powershell(String.raw`
    $file = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      # Read permissions and bytes from the same handle; do not reopen the path.
      $acl = $file.GetAccessControl()
      $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
      if ($null -eq $raw.DiscretionaryAcl -or $trusted -notcontains $acl.GetOwner($sidType).Value) {
        throw 'Expected a private ACL'
      }
      foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
        if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) {
          throw 'Unexpected allowed account'
        }
      }
      $buffer = New-Object byte[] 131
      $offset = 0
      while ($offset -lt $buffer.Length) {
        $count = $file.Read($buffer, $offset, $buffer.Length - $offset)
        if ($count -eq 0) { break }
        $offset += $count
      }
      if ($offset -gt 130) { throw 'Password file is too large' }
      [Console]::OpenStandardOutput().Write($buffer, 0, $offset)
    } finally {
      $file.Dispose()
    }
  `, path);
}

export async function createWindowsPasswordFile(path, password) {
  if (!/^[\x20-\x7e]{20,128}$/.test(password) || /[\r\n]/.test(password)) throw new Error("Invalid password.");
  await createWindowsPrivateFile(path, Buffer.from(`${password}\n`, "ascii"));
}

export async function createWindowsPrivateFile(path, bytes) {
  await powershell(String.raw`
    $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    # CreateNew enforces no overwrite. The ACL is applied at creation, not afterward.
    $file = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew,
      [System.Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $acl)
    try {
      $file.Write($bytes, 0, $bytes.Length)
    } finally {
      $file.Dispose()
    }
  `, path, bytes.toString("base64"));
}
