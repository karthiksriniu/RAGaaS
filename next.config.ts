import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse wraps pdfjs, which loads a worker and font/cmap assets at runtime
  // by resolving paths relative to its own package. Bundled by Next those paths
  // no longer exist, and every PDF upload failed on Vercel while working
  // locally - the bundler is the only difference between the two. Loading it
  // with a native require from node_modules keeps those assets reachable.
  //
  // exceljs is here for the same class of reason: it reaches for optional
  // native/stream helpers that survive bundling unreliably.
  serverExternalPackages: ["pdf-parse", "exceljs"],
};

export default nextConfig;
