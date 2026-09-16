import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop build runs `.next/standalone/server.js` inside Electron, so
  // the server and the node_modules it touches must be self-contained.
  output: "standalone",
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
