/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @log/shared ships as workspace TS/JS; let Next transpile it.
  transpilePackages: ['@log/shared'],
};

export default nextConfig;
