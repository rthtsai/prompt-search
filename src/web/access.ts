/** 存取監控用的小工具：把 User-Agent 翻成人看得懂的字、挑出看起來像爬蟲的來源。 */
export type AccessRow={ip:string;requests:number;gets:number;distinct_prompts:number;searches:number;visits:number;
  limited:number;first_seen:string;last_seen:string;ua:string|null;blocked:boolean};

const TOOLS:[RegExp,string][]=[
  [/python-requests|python-urllib|aiohttp|httpx/i,'Python 程式'],[/curl\//i,'curl'],[/wget/i,'wget'],
  [/node-fetch|axios|undici|node\.js/i,'Node 程式'],[/go-http-client/i,'Go 程式'],[/java\//i,'Java 程式'],
  [/scrapy/i,'Scrapy 爬蟲'],[/headlesschrome|puppeteer|playwright|phantomjs/i,'自動化瀏覽器'],
  [/bot|crawler|spider|slurp/i,'爬蟲'],
];
export function describeAgent(ua:string|null|undefined):string{
  if(!ua)return '—';
  for(const [re,name] of TOOLS)if(re.test(ua))return name;
  const os=/iPhone/.test(ua)?'iPhone':/iPad/.test(ua)?'iPad':/Android/.test(ua)?'Android':/Macintosh|Mac OS X/.test(ua)?'Mac'
    :/Windows/.test(ua)?'Windows':/Linux/.test(ua)?'Linux':'';
  const app=/Line\//.test(ua)?'LINE 內建瀏覽器':/Instagram/.test(ua)?'IG 內建瀏覽器':/FBAN|FBAV/.test(ua)?'FB 內建瀏覽器'
    :/Edg\//.test(ua)?'Edge':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'';
  return [os,app].filter(Boolean).join(' ')||ua.slice(0,40);
}

/** 回傳可疑的理由；看起來正常就回空字串。 */
export function looksLikeScraper(r:AccessRow,hours:number):string{
  if(r.blocked)return '';
  if(TOOLS.some(([re])=>re.test(r.ua??'')))return '看起來是程式或爬蟲，不是一般瀏覽器';
  if(r.limited>0)return `曾經 ${r.limited} 次因為拿太快被擋下`;
  if(r.gets>0&&r.visits===0)return '沒有打開網站，直接拿全文';
  if(r.distinct_prompts>=Math.max(50,Math.round(hours*5)))return `拿了 ${r.distinct_prompts} 則不同 Prompt 的全文`;
  if(r.searches>=Math.max(100,hours*20))return `搜尋了 ${r.searches} 次`;
  return '';
}
