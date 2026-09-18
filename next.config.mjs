/** @type {import('next').NextConfig} */
const nextConfig = {
  // RENAMED IN NEXT 15: `experimental.serverComponentsExternalPackages` → top-level
  // `serverExternalPackages`. Keeping the old key silently does nothing, which would let Next try
  // to bundle the native modules and break the build in a confusing way.
  //
  // These three MUST stay external. `better-sqlite3` and `sqlite-vec` are native addons (.node
  // binaries webpack cannot bundle), and `pdf-parse`'s package entry point runs a debug harness
  // that reads a fixture off disk and throws — which is also why the resume route requires
  // `pdf-parse/lib/pdf-parse.js` directly.
  serverExternalPackages: ['pdf-parse', 'better-sqlite3', 'sqlite-vec'],
  webpack: (config) => {
    config.externals = [...(config.externals || []), 'better-sqlite3', 'sqlite-vec'];
    return config;
  },
};

export default nextConfig;
