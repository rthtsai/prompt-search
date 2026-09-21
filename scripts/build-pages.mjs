import {cp,mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname} from 'node:path';
await mkdir('pages-demo/public',{recursive:true});
for(const file of ['icon.svg','icon-192.png','icon-512.png'])await cp('public/'+file,'pages-demo/public/'+file);
const child=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build','pages-demo','--webpack'],{stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',PATH:dirname(process.execPath)+':'+process.env.PATH}});
if(child.status!==0)process.exit(child.status??1);
await writeFile('pages-demo/out/.nojekyll','');
