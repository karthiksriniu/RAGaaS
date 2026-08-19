import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // exceljs reaches for optional native/stream helpers that survive bundling
  // unreliably, so it is loaded from node_modules rather than bundled.
  //
  // pdf-parse used to be listed here too: it wraps pdfjs, which resolves a
  // worker and font assets relative to its own package, and those paths stop
  // existing once bundled - PDF uploads failed on Vercel while working locally.
  // Replaced by unpdf, which ships a serverless pdfjs build with the assets
  // inlined, so no escape hatch is needed.
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
