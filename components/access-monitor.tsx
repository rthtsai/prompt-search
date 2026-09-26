'use client';
import {Fragment,useEffect,useState} from 'react';
import {Ban,LoaderCircle,RefreshCw,ShieldCheck,TriangleAlert,ChevronRight} from 'lucide-react';
import {Button} from './ui/button';
import {Modal} from './ui/dialog';
import {api} from './api';
import {describeAgent,looksLikeScraper,type AccessRow} from '../src/web/access';

type Stats={hours:number;you:string;totals:{requests:number;ips:number;limited:number;gets:number};
  ips:AccessRow[];blocked:{ip:string;reason:string;created_at:string}[]};
type Recent={at:string;op:string;target:string|null;limited:boolean;title:string|null};

const RANGES:[number,string][]=[[1,'1 小時'],[24,'24 小時'],[168,'7 天'],[720,'30 天']];
const OP:Record<string,string>={list:'打開網站',get:'看全文',search:'搜尋'};
const ago=(iso:string)=>{const m=Math.round((Date.now()-Date.parse(iso))/60000);
  return m<1?'剛剛':m<60?`${m} 分鐘前`:m<1440?`${Math.round(m/60)} 小時前`:`${Math.round(m/1440)} 天前`;};
const clock=(iso:string)=>new Date(iso).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});

/** 維護者看誰在存取、誰拿得特別兇，必要時封鎖。資料只保留 30 天。 */
export function AccessMonitor({open,onOpenChange,notify}:{open:boolean;onOpenChange:(v:boolean)=>void;notify:(s:string)=>void}){
  const [hours,setHours]=useState(24),[stats,setStats]=useState<Stats|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [openIp,setOpenIp]=useState(''),[recent,setRecent]=useState<Recent[]|null>(null);
  async function load(){setBusy(true);setError('');
    try{setStats(await api<Stats>('/api/access?hours='+hours));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  useEffect(()=>{if(open)void load();},[open,hours]);
  async function toggleRecent(ip:string){
    if(openIp===ip){setOpenIp('');return;}
    setOpenIp(ip);setRecent(null);
    try{setRecent(await api<Recent[]>('/api/access/recent?ip='+encodeURIComponent(ip)));}catch(e){setError((e as Error).message);}
  }
  async function block(ip:string,on:boolean){
    if(on&&!window.confirm(`封鎖 ${ip}？\n它會立刻看不到任何內容，之後可以在這裡解除。`))return;
    setBusy(true);
    try{await api(on?'/api/access/block':'/api/access/unblock',{method:'POST',body:JSON.stringify({ip,reason:on?'從監控面板封鎖':''})});
      notify(on?`已封鎖 ${ip}`:`已解除封鎖 ${ip}`);await load();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const rows=stats?.ips??[];
  return <Modal open={open} onOpenChange={onOpenChange} title="存取監控" description="誰在看網站、誰拿全文拿得特別兇。紀錄保留 30 天；維護者自己的操作不會被記錄。" wide>
    <div className="access-toolbar">
      <div className="access-ranges" role="group" aria-label="時間範圍">{RANGES.map(([h,label])=>
        <button key={h} className={hours===h?'active':''} aria-pressed={hours===h} onClick={()=>setHours(h)}>{label}</button>)}</div>
      <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void load()}>{busy?<LoaderCircle size={14} className="spin"/>:<RefreshCw size={14}/>}重新整理</Button>
    </div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {stats&&<div className="access-totals">
      <div><strong>{stats.totals.ips}</strong><span>個來源</span></div>
      <div><strong>{stats.totals.requests}</strong><span>次存取</span></div>
      <div><strong>{stats.totals.gets}</strong><span>次看全文</span></div>
      <div className={stats.totals.limited?'warn':''}><strong>{stats.totals.limited}</strong><span>次被擋下</span></div>
    </div>}
    {stats&&!rows.length&&<p className="access-empty">這段時間沒有任何訪客紀錄。</p>}
    {rows.length>0&&<div className="access-table-wrap"><table className="access-table">
      <thead><tr><th>來源 IP</th><th>打開網站</th><th>看全文</th><th>不同 Prompt</th><th>搜尋</th><th>被擋</th><th>最後出現</th><th>裝置</th><th/></tr></thead>
      <tbody>{rows.map(r=>{const flag=looksLikeScraper(r,stats!.hours);return <Fragment key={r.ip}>
        <tr className={`${flag?'suspect':''} ${r.blocked?'blocked':''}`}>
          <td><button className="text-link access-ip" onClick={()=>void toggleRecent(r.ip)}><ChevronRight size={13} className={openIp===r.ip?'rotate-down':''}/>{r.ip}</button>
            {r.ip===stats!.you&&<small className="access-you">目前的你</small>}
            {flag&&<small className="access-flag" title={flag}><TriangleAlert size={12}/>可疑</small>}</td>
          <td>{r.visits}</td><td>{r.gets}</td><td>{r.distinct_prompts}</td><td>{r.searches}</td><td>{r.limited||''}</td>
          <td title={clock(r.last_seen)}>{ago(r.last_seen)}</td><td className="access-ua" title={r.ua??''}>{describeAgent(r.ua)}</td>
          <td>{r.blocked
            ?<button className="text-link" disabled={busy} onClick={()=>void block(r.ip,false)}><ShieldCheck size={13}/>解除</button>
            :<button className="text-link danger" disabled={busy} onClick={()=>void block(r.ip,true)}><Ban size={13}/>封鎖</button>}</td>
        </tr>
        {openIp===r.ip&&<tr className="access-recent"><td colSpan={9}>
          {!recent?<span className="access-empty"><LoaderCircle size={13} className="spin"/>載入中…</span>
            :<ol>{recent.map((e,i)=><li key={i} className={e.limited?'limited':''}>
              <time>{clock(e.at)}</time><span>{OP[e.op]??e.op}</span><span>{e.title??''}</span>{e.limited&&<em>被擋下</em>}</li>)}</ol>}
        </td></tr>}
      </Fragment>;})}</tbody></table></div>}
    {stats&&stats.blocked.length>0&&<div className="access-blocked"><h4>封鎖中</h4><ul>{stats.blocked.map(b=>
      <li key={b.ip}><code>{b.ip}</code><span>{b.reason}</span><small>{clock(b.created_at)}</small>
        <button className="text-link" disabled={busy} onClick={()=>void block(b.ip,false)}><ShieldCheck size={13}/>解除</button></li>)}</ul></div>}
  </Modal>;
}
