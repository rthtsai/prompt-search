'use client';
import {useEffect,useState} from 'react';
import {ArrowDown,ArrowUp,Check,FolderInput,Layers,LoaderCircle,Plus,Trash2,X} from 'lucide-react';
import {Button} from './ui/button';
import {Modal} from './ui/dialog';
import {api} from './api';
import type {Variable,VariableType} from '../src/domain';
import {placeholders,type CardPrompt} from '../src/web/types';

export const typeLabels:Record<VariableType,string>={text:'自由填寫',select:'下拉選單',radio:'單選按鈕',number:'數字'};
const splitOptions=(text:string)=>text.split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean);

/** One fill-in field on the detail page, rendered according to the variable's type. */
export function VariableInput({variable:v,value,onChange}:{variable:Variable;value:string;onChange:(value:string)=>void}) {
  const id='variable-'+v.name;
  const label=<>{v.label}{v.required&&<span className="required-dot"> *</span>}</>;
  if(v.type==='radio'&&v.options?.length) return <fieldset className="variable-field variable-choice"><legend>{label}</legend><div className="choice-row" role="radiogroup">{v.options.map(o=><button type="button" id={o===v.options![0]?id:undefined} role="radio" aria-checked={value===o} key={o} className={value===o?'chosen':''} onClick={()=>onChange(value===o?'':o)}>{value===o&&<Check size={12}/>}{o}</button>)}</div></fieldset>;
  if(v.type==='select'&&v.options?.length) return <label className="variable-field" htmlFor={id}>{label}<select id={id} value={value} onChange={e=>onChange(e.target.value)}><option value="">請選擇…</option>{v.options.map(o=><option key={o}>{o}</option>)}</select></label>;
  if(v.type==='number') return <label className="variable-field" htmlFor={id}>{label}<input id={id} type="number" inputMode="numeric" placeholder={v.example||'輸入數字'} value={value} onChange={e=>onChange(e.target.value)}/></label>;
  return <label className="variable-field" htmlFor={id}>{label}<textarea id={id} rows={/文章|內容|數據|程式碼|教材/.test(v.name)?3:2} placeholder={v.example||`填入${v.label}`} value={value} onChange={e=>onChange(e.target.value)}/></label>;
}

/** Settings for every {{placeholder}} found in either language; keeps settings of names that are still used. */
export function VariableEditor({bodies,value,onChange}:{bodies:string[];value:Variable[];onChange:(value:Variable[])=>void}) {
  const names=placeholders(...bodies);
  const [optionText,setOptionText]=useState<Record<string,string>>({});
  if(!names.length) return <p className="variable-editor-empty">在內容中用 {'{{變數名稱}}'} 標出要替換的地方，這裡就會出現設定欄位（可以設成下拉選單、單選或數字）。</p>;
  const get=(name:string):Variable=>value.find(v=>v.name===name)??{name,label:name,example:'',required:true};
  const set=(name:string,patch:Partial<Variable>)=>onChange(names.map(n=>n===name?{...get(n),...patch}:get(n)));
  return <div className="variable-editor">{names.map(name=>{const v=get(name),type=v.type??'text',choice=type==='select'||type==='radio';
    return <div className="variable-editor-row" key={name}>
      <code>{'{{'+name+'}}'}</code>
      <label>顯示名稱<input value={v.label} maxLength={60} onChange={e=>set(name,{label:e.target.value})}/></label>
      <label>填寫方式<select value={type} onChange={e=>set(name,{type:e.target.value as VariableType})}>{(Object.keys(typeLabels) as VariableType[]).map(t=><option key={t} value={t}>{typeLabels[t]}</option>)}</select></label>
      {choice?<label className="wide">選項（用逗號或頓號分隔）<input placeholder="小學、中學、大學" value={optionText[name]??(v.options??[]).join('、')} onChange={e=>{setOptionText({...optionText,[name]:e.target.value});set(name,{options:splitOptions(e.target.value)});}}/></label>
        :<label className="wide">範例／提示<input value={v.example} maxLength={200} onChange={e=>set(name,{example:e.target.value})}/></label>}
      <label className="check"><input type="checkbox" checked={v.required} onChange={e=>set(name,{required:e.target.checked})}/>必填</label>
    </div>;})}</div>;
}

type Row={key:string;name:string;from?:string;fixed?:boolean;count:number};
export function CategoryManager({open,onOpenChange,categories,onSaved}:{open:boolean;onOpenChange:(v:boolean)=>void;categories:{name:string;count:number;fixed?:boolean}[];onSaved:(message:string)=>void}) {
  const [rows,setRows]=useState<Row[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[adding,setAdding]=useState('');
  useEffect(()=>{if(open){setRows(categories.map(c=>({key:c.name,name:c.name,from:c.name,fixed:c.fixed||c.name==='其他',count:c.count})));setError('');setAdding('');}},[open]); // eslint-disable-line react-hooks/exhaustive-deps -- background refreshes must not wipe unsaved edits
  const movable=rows.filter(r=>!r.fixed),fixed=rows.filter(r=>r.fixed);
  const move=(i:number,d:number)=>{const next=[...movable];const j=i+d;if(j<0||j>=next.length)return;[next[i],next[j]]=[next[j],next[i]];setRows([...next,...fixed]);};
  const add=()=>{const name=adding.trim();if(!name)return;if(rows.some(r=>r.name.trim()===name)){setError(`已經有「${name}」`);return;}setRows([...movable,{key:'new-'+crypto.randomUUID(),name,count:0},...fixed]);setAdding('');setError('');};
  async function save(){
    setError('');const names=rows.map(r=>r.name.trim());
    if(names.some(n=>!n))return setError('分類名稱不能空白');
    const dup=names.find((n,i)=>names.indexOf(n)!==i);if(dup)return setError(`分類名稱重複：${dup}`);
    const removed=categories.filter(c=>!rows.some(r=>r.from===c.name)&&c.count>0);
    if(removed.length&&!window.confirm(`刪除分類後，${removed.map(c=>`「${c.name}」的 ${c.count} 則`).join('、')} Prompt 會移到「其他」。確定嗎？`))return;
    setBusy(true);
    try{await api('/api/categories',{method:'POST',body:JSON.stringify({items:rows.map(r=>({name:r.name.trim(),from:r.from}))})});onOpenChange(false);onSaved('分類已更新');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal open={open} onOpenChange={onOpenChange} title="管理分類" description="新增、改名、調整順序。刪除的分類，裡面的 Prompt 會移到「其他」。">
    <div className="category-manager">
      <ol>{movable.map((r,i)=><li key={r.key}><span className="category-number">{String(i+1).padStart(2,'0')}</span><input aria-label={`分類 ${i+1} 名稱`} value={r.name} maxLength={30} onChange={e=>setRows(rows.map(x=>x.key===r.key?{...x,name:e.target.value}:x))}/><small>{r.count} 則</small>
        <button className="icon-button" aria-label="往上移" disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp size={15}/></button>
        <button className="icon-button" aria-label="往下移" disabled={i===movable.length-1} onClick={()=>move(i,1)}><ArrowDown size={15}/></button>
        <button className="icon-button danger" aria-label={`刪除分類 ${r.name}`} onClick={()=>setRows(rows.filter(x=>x.key!==r.key))}><Trash2 size={15}/></button></li>)}
        {fixed.map(r=><li key={r.key} className="pinned"><span className="category-number">—</span><span className="fixed-name">{r.name}</span><small>{r.count} 則 · 固定在最後，暫時放不知道怎麼分的</small></li>)}
      </ol>
      <div className="category-add"><input placeholder="新分類名稱，例如「出題」「Shortcut 1」" value={adding} maxLength={30} onChange={e=>setAdding(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();add();}}}/><Button variant="outline" size="sm" onClick={add}><Plus size={15}/>新增</Button></div>
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer"><Button variant="ghost" onClick={()=>onOpenChange(false)} disabled={busy}>取消</Button><Button onClick={()=>void save()} disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>}儲存分類</Button></div>
  </Modal>;
}

const natural=new Intl.Collator('zh-Hant',{numeric:true});
/** Orders several separately saved prompts (e.g. V1…V5) and turns them into versions of one prompt. */
export function MergeDialog({items,onClose,onMerged}:{items:CardPrompt[]|null;onClose:()=>void;onMerged:()=>void}) {
  const [order,setOrder]=useState<CardPrompt[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(items){setOrder([...items].sort((a,b)=>natural.compare(a.title,b.title)||(a.created_at??a.updated_at).localeCompare(b.created_at??b.updated_at)));setError('');}},[items]);
  const move=(i:number,d:number)=>{const next=[...order];const j=i+d;if(j<0||j>=next.length)return;[next[i],next[j]]=[next[j],next[i]];setOrder(next);};
  async function merge(){setBusy(true);setError('');try{
    const ids=order.flatMap(p=>[...(p.versions??[p])].sort((a,b)=>(a.version_no??1)-(b.version_no??1)).map(v=>v.id));
    await api('/api/bulk',{method:'POST',body:JSON.stringify({action:'merge',ids})});onMerged();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <Modal open={!!items} onOpenChange={o=>{if(!o)onClose();}} title="合併成同一個 Prompt 的版本" description="由上到下是舊到新，最下面的會成為預設顯示的最新版。舊版本之後仍可在詳細頁切換查看。">
    <div className="category-manager"><ol>{order.map((p,i)=><li key={p.id}><span className="category-number">V{i+1}</span><span className="fixed-name">{p.title}{p.versions&&<small>（含 {p.versions.length} 個版本）</small>}</span>
      <button className="icon-button" aria-label="往上移" disabled={i===0} onClick={()=>move(i,-1)}><ArrowUp size={15}/></button>
      <button className="icon-button" aria-label="往下移" disabled={i===order.length-1} onClick={()=>move(i,1)}><ArrowDown size={15}/></button></li>)}</ol>
      {error&&<p className="form-error" role="alert">{error}</p>}</div>
    <div className="modal-footer"><Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button><Button onClick={()=>void merge()} disabled={busy||order.length<2}>{busy?<LoaderCircle size={16} className="spin"/>:<Layers size={16}/>}合併為 {order.length} 個版本</Button></div>
  </Modal>;
}

/** Sticky action bar for the selected cards. */
export function BulkBar({selected,categories,onMove,onMerge,onDelete,onClear,busy}:{selected:CardPrompt[];categories:string[];onMove:(category:string)=>void;onMerge:()=>void;onDelete:()=>void;onClear:()=>void;busy:boolean}) {
  if(!selected.length) return null;
  return <div className="bulk-bar" role="toolbar" aria-label="批次操作">
    <strong>已選 {selected.length} 則</strong>
    <label className="bulk-move"><FolderInput size={15}/><select aria-label="批次移到分類" value="" disabled={busy} onChange={e=>{if(e.target.value)onMove(e.target.value);}}><option value="">移到分類…</option>{categories.map(c=><option key={c}>{c}</option>)}</select></label>
    <Button variant="outline" size="sm" disabled={busy||selected.length<2} onClick={onMerge} title="把 V1、V2…合併成同一個 Prompt"><Layers size={15}/>合併成版本</Button>
    <Button variant="outline" size="sm" className="danger" disabled={busy} onClick={onDelete}><Trash2 size={15}/>刪除</Button>
    <button className="icon-button" aria-label="取消選取" onClick={onClear}><X size={17}/></button>
  </div>;
}
