import { realpathSync } from "node:fs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: realpathSync(process.cwd()),
  },
};

export default nextConfig;
