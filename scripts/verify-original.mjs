// 驗收第 1 項：確認班級版的改動沒有動到原版的建置結果。
// Next.js 每次建置會產生隨機 buildId，所以比對時把它正規化掉。
import {readdir,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,relative} from 'node:path';
async function walk(dir,base=dir,out=[]){
  for(const e of await readdir(dir,{withFileTypes:true})){
    const p=join(dir,e.name);
    if(e.isDirectory())await walk(p,base,out); else out.push(relative(base,p));
  }
  return out;
}
const normalize=(name,text,buildId)=>({
  name:name.replaceAll(buildId,'BUILD'),
  hash:createHash('sha256').update(text.replaceAll(buildId,'BUILD')).digest('hex')});
async function fingerprint(dir){
  const files=(await walk(dir)).sort();
  const manifest=files.find(f=>f.includes('_buildManifest.js'))??'';
  const buildId=manifest.split('/').find(p=>/^[A-Za-z0-9_-]{15,}$/.test(p))??'__none__';
  const rows=[];
  for(const f of files){
    const full=join(dir,f);
    const binary=/\.(png|jpg|jpeg|webp|ico|woff2?)$/.test(f);
    const text=binary?(await readFile(full)).toString('base64'):await readFile(full,'utf8');
    rows.push(normalize(f,text,buildId));
  }
  return rows.sort((a,b)=>a.name.localeCompare(b.name));
}
const [a,b]=[process.argv[2]??'docs',process.argv[3]??'pages-demo/out'];
const [x,y]=await Promise.all([fingerprint(a),fingerprint(b)]);
const only=(p,q)=>p.filter(r=>!q.some(s=>s.name===r.name)).map(r=>r.name);
const changed=x.filter(r=>y.some(s=>s.name===r.name&&s.hash!==r.hash)).map(r=>r.name);
const skip=n=>n.endsWith('.md')||n.endsWith('.yml');
const missing=only(x,y).filter(n=>!skip(n)),added=only(y,x).filter(n=>!skip(n));
if(!missing.length&&!added.length&&!changed.length){console.log(`原版建置結果一致：${y.length} 個檔案，${a} ↔ ${b}`);process.exit(0);}
console.log('有差異：');
if(missing.length)console.log(' 少了：',missing.slice(0,10));
if(added.length)console.log(' 多了：',added.slice(0,10));
if(changed.length)console.log(' 內容不同：',changed.slice(0,10));
process.exit(1);
