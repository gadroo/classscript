import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@curriculum/api", "@curriculum/schemas", "@curriculum/prompts", "@curriculum/rendering"],
};

export default nextConfig;
