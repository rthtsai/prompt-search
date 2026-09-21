const basePath=process.env.PAGES_BASE_PATH??'/prompt-search';
if(basePath&&!/^\/[a-zA-Z0-9_/-]+$/.test(basePath))throw new Error('Invalid PAGES_BASE_PATH');
export default {output:'export',basePath,trailingSlash:true,images:{unoptimized:true},env:{NEXT_PUBLIC_PAGES_DEMO:'true',NEXT_PUBLIC_BASE_PATH:basePath},poweredByHeader:false};
