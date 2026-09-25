// GitHub Pages 建置。Next 的 project dir 是 pages-demo，不會去讀專案根目錄的 .env，
// 所以這裡自己讀進來——少了 Supabase 設定就會靜靜地建出一個「資料全不見」的站，
// 因此缺 key 一律直接中止，不讓它建完。
import {cp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname} from 'node:path';

const env={...process.env};
if(existsSync('.env')){
  for(const line of (await readFile('.env','utf8')).split('\n')){
    const m=/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if(m&&!env[m[1]])env[m[1]]=m[2].trim().replace(/^["']|["']$/g,'');
  }
}
for(const key of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']){
  if(!env[key]){console.error(`缺少 ${key}（請寫在 .env）。沒有它建出來的站會是空的，不繼續。`);process.exit(1);}
}

await mkdir('pages-demo/public',{recursive:true});
for(const file of ['icon.svg','icon-192.png','icon-512.png','logo-lockup.png','logo-full.png'])await cp('public/'+file,'pages-demo/public/'+file);
const child=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build','pages-demo','--webpack'],{stdio:'inherit',env:{...env,NEXT_TELEMETRY_DISABLED:'1',PATH:dirname(process.execPath)+':'+process.env.PATH}});
if(child.status!==0)process.exit(child.status??1);

// 最後再確認一次：設定真的被編進 bundle 了，而不是被當成空字串編掉
const {readdir}=await import('node:fs/promises');
const host=new URL(env.NEXT_PUBLIC_SUPABASE_URL).host.split('.')[0];
const chunks='pages-demo/out/_next/static/chunks/app';
let baked=false;
for(const file of await readdir(chunks,{recursive:true})){
  if(!file.endsWith('.js'))continue;
  if((await readFile(chunks+'/'+file,'utf8')).includes(host)){baked=true;break;}
}
if(!baked){console.error(`建出來的檔案裡找不到 ${host}，代表設定沒有進去，站會是空的。`);process.exit(1);}

await writeFile('pages-demo/out/.nojekyll','');
