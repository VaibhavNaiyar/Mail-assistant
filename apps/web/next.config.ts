import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@clira/ui", "@clira/db"],
};

export default nextConfig;
