/**
 * Keys whose values are treated as secret. Resolved values are never shown by
 * default: this app reads real credentials out of the user's config, so the
 * safe default is to mask and let the user opt in per view.
 */
const SECRET_KEY =
  /(token|key|secret|password|passwd|auth|credential|api[-_]?key)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** `ghp_abc…xyz` becomes `••••••••••`, preserving nothing about the value. */
export function maskValue(value: string): string {
  return value.length === 0 ? "" : "•".repeat(10);
}

/** Masks secret-looking values inside a JSON string, for the raw config view. */
export function maskJsonSecrets(text: string): string {
  return text.replace(
    /("(?:[^"]*(?:token|key|secret|password|auth|credential)[^"]*)"\s*:\s*)"[^"]*"/gi,
    '$1"••••••••••"',
  );
}

export function looksSensitive(text: string): boolean {
  return /"(?:[^"]*(?:token|key|secret|password|auth|credential)[^"]*)"\s*:/i.test(
    text,
  );
}
