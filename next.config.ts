import type {NextConfig} from 'next';
const config:NextConfig={devIndicators:false,poweredByHeader:false,serverExternalPackages:['pg'],turbopack:{root:process.cwd()}};
export default config;
