'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowDown,ArrowUp,Check,ChevronDown,FileText,FolderInput,ImagePlus,Layers,LoaderCircle,MessageSquareText,PenLine,Plus,Trash2,X} from 'lucide-react';
import {Button} from './ui/button';
import {Modal} from './ui/dialog';
import {api,uploadExample,uploadTextExample} from './api';
import {exampleTypes,exampleUrl} from '../src/web/cloud-store';
import type {Variable,VariableType} from '../src/domain';
import {placeholders,beforeAfter,type CardPrompt,type ExampleItem} from '../src/web/types';

export const typeLabels:Record<VariableType,string>={text:'自由填寫',select:'下拉選單',radio:'單選按鈕',number:'數字'};
const splitOptions=(text:string)=>text.split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean);

/** One fill-in field on the detail page, rendered according to the variable's type. */
export function VariableInput({variable:v,value,onChange,invalid=false}:{variable:Variable;value:string;onChange:(value:string)=>void;invalid?:boolean}) {
  const id='variable-'+v.name;
  // 清空一格：手機上要她按一長串 backspace 才刪得掉，太苦了
  const clear=value?<button type="button" className="field-clear" aria-label={`清空${v.label}`}
    onClick={()=>onChange('')}><X size={13}/></button>:null;
  const note=invalid?<small className="field-error" id={id+'-error'}>這一格還沒填</small>:null;
  const flags={'aria-invalid':invalid||undefined,'aria-describedby':invalid?id+'-error':undefined} as const;
  const label=<>{v.label}{v.required&&<span className="required-dot"> *</span>}{clear}</>;
  if(v.type==='radio'&&v.options?.length) return <fieldset className={`variable-field variable-choice ${invalid?'is-invalid':''}`}><legend>{label}</legend><div className="choice-row" role="radiogroup">{v.options.map(o=><button type="button" id={o===v.options![0]?id:undefined} role="radio" aria-checked={value===o} key={o} className={value===o?'chosen':''} onClick={()=>onChange(value===o?'':o)}>{value===o&&<Check size={12}/>}{o}</button>)}</div>{note}</fieldset>;
  if(v.type==='select'&&v.options?.length) return <label className={`variable-field ${invalid?'is-invalid':''}`} htmlFor={id}>{label}<select id={id} {...flags} value={value} onChange={e=>onChange(e.target.value)}><option value="">請選擇…</option>{v.options.map(o=><option key={o}>{o}</option>)}</select>{note}</label>;
  if(v.type==='number') return <label className={`variable-field ${invalid?'is-invalid':''}`} htmlFor={id}>{label}<input id={id} {...flags} type="number" inputMode="numeric" placeholder={v.example||'輸入數字'} value={value} onChange={e=>onChange(e.target.value)}/>{note}</label>;
  return <label className={`variable-field ${invalid?'is-invalid':''}`} htmlFor={id}>{label}<textarea id={id} {...flags} rows={/文章|內容|數據|程式碼|教材/.test(v.name)?3:2} placeholder={v.example||`填入${v.label}`} value={value} onChange={e=>onChange(e.target.value)}/>{note}</label>;
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

/** What a prompt produced: pictures, files to download, or the text answer itself. */

type ExampleEntry={id?:string;path?:string;caption:string;name?:string};
/** 範例說明：看得到、改得動。沒寫的時候維護者會看到一個明確的入口。 */
function ExampleCaption({entry,manage,busy,editing,draft,tag:Tag='figcaption',
    onStart,onDraft,onSave,onCancel}:{
    entry:ExampleEntry;manage:boolean;busy:boolean;editing:boolean;draft:string;
    tag?:'figcaption'|'div';onStart(text:string):void;onDraft(text:string):void;
    onSave():void;onCancel():void}) {
  if(editing) return <Tag className="example-caption-edit">
    <input autoFocus value={draft} maxLength={200} placeholder="這個範例在示範什麼？" aria-label="範例說明"
      onChange={e=>onDraft(e.target.value)}
      onKeyDown={e=>{if(e.key==='Enter')onSave();if(e.key==='Escape')onCancel();}}/>
    <Button size="sm" disabled={busy} onClick={onSave}><Check size={14}/>儲存</Button>
    <button type="button" className="text-link" onClick={onCancel}>取消</button>
  </Tag>;
  if(entry.caption) return <Tag className="example-caption-line">{entry.caption}
    {manage&&<button type="button" className="text-link" aria-label="修改這個範例的說明"
      onClick={()=>onStart(entry.caption)}><PenLine size={12}/>改說明</button>}</Tag>;
  if(!manage) return null;
  return <Tag className="example-caption-line"><button type="button" className="text-link"
    onClick={()=>onStart('')}><Plus size={12}/>加上說明</button></Tag>;
}

// manage＝維護者（可以移除範例）；contribute＝任何人都能做的貢獻（加範例、補說明）
export function ExampleGallery({prompt,storage,manage,contribute,onChanged,notify}:{prompt:CardPrompt;storage?:string;manage:boolean;contribute:boolean;onChanged:()=>void;notify:(s:string,undo?:()=>void)=>void}) {
  const [busy,setBusy]=useState(false),[caption,setCaption]=useState(''),[zoom,setZoom]=useState(''),[text,setText]=useState(''),[writing,setWriting]=useState(false);
  // 事後補說明：editing 記住正在改哪一個範例
  const [editing,setEditing]=useState<string>(''),[draft,setDraft]=useState('');
  const [asInput,setAsInput]=useState(false);   // 接下來要加的那一張是不是原圖
  const [dropping,setDropping]=useState<typeof items[number]|null>(null);
  const input=useRef<HTMLInputElement>(null);
  const items=prompt.examples??[];
  if(!storage||(!items.length&&!contribute)) return null;
  const kindOf=(e:typeof items[number])=>e.kind??'image';
  async function run(what:Promise<unknown>,done:string){
    setBusy(true);
    try{await what;setCaption('');setText('');setWriting(false);setAsInput(false);notify(done);onChanged();}
    catch(e){notify((e as Error).message);}finally{setBusy(false);}
  }
  const remove=(e:typeof items[number])=>{
    setDropping(null);
    void run(api('/api/examples',{method:'DELETE',body:JSON.stringify({id:prompt.id,path:e.path,entryId:e.id})}),'已移除範例');
  };
  const keyOf=(e:typeof items[number])=>e.id??e.path??'';
  const setRole=(e:typeof items[number],role:'input'|'output')=>
    void run(api('/api/examples',{method:'POST',body:JSON.stringify({id:prompt.id,entryId:e.id,path:e.path,role})}),
      role==='input'?'已標成原圖':'已標成產出');
  const saveCaption=(e:typeof items[number])=>{
    setEditing('');
    void run(api('/api/examples',{method:'POST',body:JSON.stringify({id:prompt.id,entryId:e.id,path:e.path,caption:draft})}),
      draft.trim()?'說明已更新':'說明已清空');
  };
  // 綁 props 而不是在 render 裡宣告元件：後者每打一個字就重新掛載，手機上會一直掉焦點
  const capProps=(e:typeof items[number])=>({entry:e as ExampleEntry,busy,
    manage:contribute,editing:editing===keyOf(e),draft,
    onStart:(text:string)=>{setEditing(keyOf(e));setDraft(text);},onDraft:setDraft,
    onSave:()=>saveCaption(e),onCancel:()=>setEditing('')});
  const size=(n?:number)=>n?n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.max(1,Math.round(n/1024))} KB`:'';
  const pair=beforeAfter(items),rest=pair.rest,videos=items.filter(e=>kindOf(e)==='video'&&e.path),
    others=items.filter(e=>!['image','video'].includes(kindOf(e)));
  return <section className="example-panel">
    <div className="panel-label"><span>03</span><h3>這個 Prompt 做出來的樣子</h3>{items.length>0&&<span className="live-label">{items.length} 個</span>}</div>
    {pair.before&&pair.after&&<div className="example-pair">
      {[['原圖',pair.before],['這個 Prompt 做出來的',pair.after]].map(([label,e])=>
        <figure key={(e as ExampleItem).id??(e as ExampleItem).path}>
          <span className="pair-label">{label as string}</span>
          <button className="example-open" onClick={()=>setZoom(exampleUrl(storage!,(e as ExampleItem).path!))} aria-label={(e as ExampleItem).caption||(label as string)}>
            <img src={exampleUrl(storage!,(e as ExampleItem).path!)} alt={(e as ExampleItem).caption||`${prompt.title} 的${label}`} loading="lazy"/></button>
          <ExampleCaption {...capProps(e as ExampleItem)}/>
          {contribute&&<button type="button" className="text-link pair-swap"
            onClick={()=>setRole(e as ExampleItem,(e as ExampleItem).role==='input'?'output':'input')} disabled={busy}>
            {(e as ExampleItem).role==='input'?'其實這是產出':'其實這是原圖'}</button>}
          {manage&&<button className="icon-button danger example-remove" aria-label="移除這個範例" disabled={busy} onClick={()=>setDropping(e as ExampleItem)}><Trash2 size={14}/></button>}
        </figure>)}
    </div>}
    {rest.length>0&&<div className="example-grid">{rest.map(e=><figure key={e.id??e.path}>
      <button className="example-open" onClick={()=>setZoom(exampleUrl(storage!,e.path!))} aria-label={e.caption||'放大範例圖片'}>
        <img src={exampleUrl(storage!,e.path!)} alt={e.caption||`${prompt.title} 的範例圖片`} loading="lazy"/></button>
      <ExampleCaption {...capProps(e)}/>
      {contribute&&<button type="button" className="text-link" disabled={busy}
        onClick={()=>setRole(e,e.role==='input'?'output':'input')}>
        {e.role==='input'?'標成產出':'標成原圖'}</button>}
      {manage&&<button className="icon-button danger example-remove" aria-label="移除這個範例" disabled={busy} onClick={()=>setDropping(e)}><Trash2 size={14}/></button>}
    </figure>)}</div>}
    {videos.length>0&&<div className="example-videos">{videos.map(e=><figure key={e.id??e.path}>
      <video controls preload="metadata" playsInline src={exampleUrl(storage!,e.path!)}/>
      <ExampleCaption {...capProps(e)}/>
      {manage&&<button className="icon-button danger example-remove" aria-label="移除這個範例" disabled={busy} onClick={()=>setDropping(e)}><Trash2 size={14}/></button>}
    </figure>)}</div>}
    {others.length>0&&<div className="example-list">{others.map(e=>kindOf(e)==='file'
      ? <div className="example-file" key={e.id??e.path}>
          <span className="file-mark"><FileText size={17}/></span>
          <a href={exampleUrl(storage!,e.path!)} target="_blank" rel="noopener noreferrer" download={e.name}>{e.name||'下載檔案'}</a>
          <small>{[exampleTypes[e.mime??'']?.label,size(e.size)].filter(Boolean).join(' · ')}</small>
          <ExampleCaption {...capProps(e)} tag="div"/>
          {manage&&<button className="icon-button danger" aria-label="移除這個範例" disabled={busy} onClick={()=>setDropping(e)}><Trash2 size={14}/></button>}
        </div>
      : <details className="example-text" key={e.id}><summary><MessageSquareText size={15}/>{e.caption||'文字結果'}<ChevronDown size={15}/></summary>
          <pre>{e.text}</pre>
          <ExampleCaption {...capProps(e)} tag="div"/>
          {manage&&<button className="icon-button danger" aria-label="移除這個範例" disabled={busy} onClick={()=>setDropping(e)}><Trash2 size={14}/></button>}
        </details>)}</div>}
    {contribute&&items.length<6&&<div className="example-add">
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json" hidden
        onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void run(uploadExample(prompt.id,f,caption,asInput?'input':'output'),'範例已加入');}}/>
      <input className="example-caption" placeholder="接下來要加的那一個的說明（選填，之後也能改）" maxLength={200} value={caption} onChange={e=>setCaption(e.target.value)}/>
      <label className="example-asinput"><input type="checkbox" checked={asInput} onChange={e=>setAsInput(e.target.checked)}/>這張是原圖（丟進 AI 之前的那張）</label>
      <Button variant="outline" size="sm" disabled={busy} onClick={()=>input.current?.click()}>{busy?<LoaderCircle size={15} className="spin"/>:<ImagePlus size={15}/>}加圖片或檔案</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={()=>setWriting(!writing)}><MessageSquareText size={15}/>貼上文字結果</Button>
    </div>}
    {contribute&&writing&&<div className="example-text-add">
      <textarea rows={5} maxLength={8000} placeholder="把 AI 回答的結果貼在這裡，讓大家看到這個 Prompt 實際跑出什麼。" value={text} onChange={e=>setText(e.target.value)}/>
      <Button size="sm" disabled={busy||!text.trim()} onClick={()=>void run(uploadTextExample(prompt.id,text,caption),'文字範例已加入')}>{busy?<LoaderCircle size={15} className="spin"/>:<Check size={15}/>}加入文字範例</Button>
    </div>}
    {contribute&&<p className="example-note">圖片 JPG／PNG／WebP（自動縮小，3 MB 內）；檔案 PDF、Word、Excel、PowerPoint、txt、md、csv、json（10 MB 內）；或直接貼上文字。每則最多 6 個，所有人都看得到。</p>}
    <ConfirmDelete open={!!dropping} busy={busy} title={dropping?.caption||dropping?.name||'這個範例'}
      origin={`${prompt.title} 的範例`} scope="移除之後所有人都看不到這個範例，而且不能復原。"
      onCancel={()=>setDropping(null)} onConfirm={()=>{if(dropping)remove(dropping);}}/>
    {zoom&&<button className="example-lightbox" onClick={()=>setZoom('')} aria-label="關閉放大檢視"><img src={zoom} alt="範例圖片放大"/></button>}
  </section>;
}

/**
 * 刪除確認。原本用的是 window.confirm，只寫「刪除這個 Prompt？」——
 * 她問的正是「你確定刪的不是我自己改的那一個嗎」，所以這裡一定要講出
 * 刪的是哪一則、它是哪裡來的，而且要按兩次才真的刪。
 */
export function ConfirmDelete({open,title,origin,scope,busy,onCancel,onConfirm}:{
    open:boolean;title:string;origin:string;scope:string;busy:boolean;
    onCancel:()=>void;onConfirm:()=>void}) {
  const [armed,setArmed]=useState(false);
  // 預設焦點放在「取消」，手機上誤觸 Enter 才不會直接刪掉
  useEffect(()=>{if(open){setArmed(false);
    setTimeout(()=>document.getElementById('confirm-cancel')?.focus(),0);}},[open]);
  return <Modal open={open} onOpenChange={next=>{if(!next)onCancel();}} title="確定要刪除嗎？"
    description="刪掉之後，所有人都會看不到。">
    <div className="confirm-delete">
      <p className="confirm-title">{title}</p>
      <p className="confirm-origin">{origin}</p>
      <p className="confirm-warning"><Trash2 size={15}/>{scope}</p>
      <div className="modal-footer">
        <Button id="confirm-cancel" variant="outline" onClick={onCancel} disabled={busy}>取消</Button>
        <Button className="danger-solid" disabled={busy}
          onClick={()=>armed?onConfirm():setArmed(true)}>
          {busy?<LoaderCircle size={16} className="spin"/>:<Trash2 size={16}/>}
          {armed?'再按一次才會刪除':'確定刪除'}</Button>
      </div>
    </div>
  </Modal>;
}

/** 這一則是哪裡來的——確認視窗要靠它回答「這是不是我自己改的那一份」。 */
export function originOf(p:{source?:string;fork_of?:string|null;version_no?:number}):string{
  if(p.fork_of)return '從其他範本另存出來的一份';
  if(p.source==='fixtures/prompts.json')return '站上原本就有的';
  if(p.source==='貼上文字')return '由使用者貼上加入';
  return p.source?`來自「${p.source}」`:'來源不明';
}
