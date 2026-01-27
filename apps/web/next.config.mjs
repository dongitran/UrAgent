/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  // Exclude server-only packages from client bundle
  serverComponentsExternalPackages: ['mongodb'],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Don't bundle MongoDB and its dependencies on client-side
      config.resolve.fallback = {
        ...config.resolve.fallback,
        'mongodb': false,
        'mongodb-client-encryption': false,
        '@mongodb-js/zstd': false,
        '@mongodb-js/saslprep': false,
        'kerberos': false,
        'snappy': false,
        'aws4': false,
        'gcp-metadata': false,
      };
    }
    return config;
  },
};

export default nextConfig;
