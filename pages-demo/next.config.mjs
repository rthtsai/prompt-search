const basePath=process.env.PAGES_BASE_PATH??'/prompt-search';
if(basePath&&!/^\/[a-zA-Z0-9_/-]+$/.test(basePath))throw new Error('Invalid PAGES_BASE_PATH');
export default {output:'export',basePath,trailingSlash:true,images:{unoptimized:true},env:{NEXT_PUBLIC_STORAGE_MODE:process.env.NEXT_PUBLIC_STORAGE_MODE??'local',NEXT_PUBLIC_SUPABASE_URL:process.env.NEXT_PUBLIC_SUPABASE_URL??'',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY??'',NEXT_PUBLIC_PAGES_DEMO:'true',NEXT_PUBLIC_BASE_PATH:basePath},poweredByHeader:false};
