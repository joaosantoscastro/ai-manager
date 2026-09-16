import type { NextConfig } from "next";

/**
 * The app renders its own local server in an Electron window and never loads
 * third-party content, so it can afford a strict policy. The main value is
 * containment: if a reflected string ever escapes escaping again, the policy
 * stops it from loading remote script or phoning anything home.
 *
 * `'unsafe-inline'` is required for style because Next.js injects inline
 * style attributes, and for script because the OAuth callback page carries a
 * small inline block that closes the popup.
 *
 * `'unsafe-eval'` is added for development only. React's dev build calls
 * `eval()` for debugging features such as rebuilding callstacks, and refuses
 * to start without it. The shipped desktop app runs a production build, so it
 * never receives this relaxation.
 */
const isDev = process.env.NODE_ENV !== "production";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // Loopback only. The UI talks to its own server and nothing else.
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // The desktop build runs `.next/standalone/server.js` inside Electron, so
  // the server and the node_modules it touches must be self-contained.
  output: "standalone",
  outputFileTracingRoot: __dirname,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
