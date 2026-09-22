import type { NextConfig } from "next";

const config: NextConfig = {
  // postgres.js is a Node driver; keep it out of the bundler so its dynamic
  // requires resolve at runtime rather than being traced at build time.
  serverExternalPackages: ["postgres"],
};

export default config;
