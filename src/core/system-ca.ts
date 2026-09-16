/**
 * Certificate authorities taken from the operating system's own trust store.
 *
 * Node ships a fixed, bundled CA list and — unlike `curl` — never consults
 * the macOS keychain. On a machine behind a TLS-inspecting corporate proxy
 * this is the difference between working and not: the proxy re-signs every
 * certificate with a private root that is installed in the System keychain,
 * so Node rejects the connection with `SELF_SIGNED_CERT_IN_CHAIN` while
 * every other tool on the machine succeeds. That is exactly why MCP servers
 * on internal hosts failed here but responded fine to `curl`.
 *
 * These roots are *added* to Node's defaults, never substituted for them,
 * and certificate verification stays switched on. This only teaches Node
 * about authorities the operating system already trusts.
 *
 * Read once per process and cached: shelling out to `security` costs tens
 * of milliseconds and the trust store does not change while the app runs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The keychains holding trusted roots on macOS. `System.keychain` is where
 * an MDM-managed corporate root is installed; `SystemRootCertificates` is
 * Apple's own bundled set.
 */
const MACOS_KEYCHAINS = [
  "/Library/Keychains/System.keychain",
  "/System/Library/Keychains/SystemRootCertificates.keychain",
];

const PEM_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

let cached: string[] | null = null;

async function readKeychain(keychain: string): Promise<string[]> {
  try {
    // `-a` every matching certificate, `-p` as PEM. Read-only: nothing is
    // exported to disk and no private key is ever touched.
    const { stdout } = await run(
      "security",
      ["find-certificate", "-a", "-p", keychain],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.match(PEM_PATTERN) ?? [];
  } catch {
    // A locked or missing keychain is not an error worth surfacing: the
    // caller still has Node's bundled roots and most servers will verify.
    return [];
  }
}

/**
 * Extra trusted roots for this machine, as PEM strings. Returns an empty
 * array on any platform without a reader, so callers never need to branch.
 */
export async function getSystemCertificates(): Promise<string[]> {
  if (cached) return cached;
  if (process.platform !== "darwin") {
    cached = [];
    return cached;
  }

  const found = await Promise.all(MACOS_KEYCHAINS.map(readKeychain));
  // The two keychains overlap, and a duplicated root is wasted verification
  // work on every single connection.
  cached = [...new Set(found.flat())];
  return cached;
}

/** True when a TLS failure is the corporate-root problem this module solves. */
export function isUntrustedCertificateError(code: unknown): boolean {
  return (
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
  );
}
