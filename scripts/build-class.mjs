// 班級版建置：讀 .env.class（不進版控），輸出到 pages-demo/out-class/，
// 可選擇同步到 ../ai-class-lab/docs/。原版的 pages:build 不受影響。
import {cp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';

const env={...process.env};
if(existsSync('.env.class')){
  for(const line of (await readFile('.env.class','utf8')).split('\n')){
    const m=/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if(m) env[m[1]]=m[2].trim().replace(/^["']|["']$/g,'');
  }
} else console.warn('沒有 .env.class，改用目前的環境變數');
env.NEXT_PUBLIC_CLASS_MODE='true';
env.NEXT_PUBLIC_STORAGE_MODE=env.NEXT_PUBLIC_STORAGE_MODE??'cloud';
env.PAGES_BASE_PATH=env.PAGES_BASE_PATH??'/ai-class-lab';
for(const key of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']){
  if(!env[key]){console.error(`缺少 ${key}（請寫在 .env.class）`);process.exit(1);}
}
if(env.NEXT_PUBLIC_SUPABASE_URL.includes('ybzgijbacnsegmtfubmf')){
  console.error('班級版不可以指向原版的 Supabase 專案');process.exit(1);
}
// 建置期間把進入點換成班級版，結束後一定還原
const entry='pages-demo/app/page.tsx', original=await readFile(entry,'utf8');
await writeFile(entry,await readFile('scripts/class-entry.tsx.txt','utf8'));
process.on('exit',()=>{try{require('node:fs').writeFileSync(entry,original);}catch{}});
await mkdir('pages-demo/public',{recursive:true});
for(const file of ['icon.svg','icon-192.png','icon-512.png'])await cp('public/'+file,'pages-demo/public/'+file);
await rm('pages-demo/out-class',{recursive:true,force:true});
env.NEXT_DIST_DIR='.next-class';
const child=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build','pages-demo','--webpack'],
  {stdio:'inherit',env:{...env,NEXT_TELEMETRY_DISABLED:'1',PATH:dirname(process.execPath)+':'+env.PATH}});
if(child.status!==0)process.exit(child.status??1);
await cp('pages-demo/out','pages-demo/out-class',{recursive:true});
await rm('pages-demo/out',{recursive:true,force:true});
await writeFile('pages-demo/out-class/.nojekyll','');
await writeFile(entry,original);
console.log('班級版建置完成：pages-demo/out-class/');
const target=process.argv[2];
if(target){
  const docs=join(target,'docs');
  await rm(docs,{recursive:true,force:true});
  await mkdir(docs,{recursive:true});
  await cp('pages-demo/out-class',docs,{recursive:true});
  console.log('已同步到',docs);
}
