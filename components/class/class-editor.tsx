'use client';
// 班級版的編輯頁。規則都在 src/web/class-editor.ts，這裡只負責畫面與瀏覽器那一端的圖片壓縮。
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ImagePlus,LoaderCircle,MessageSquarePlus,Save,Trash2,TriangleAlert,
  GitBranch} from 'lucide-react';
import {Button} from '../ui/button';
import {asDataUrl,isMine,fetchVersions,type ClassCard,type ClassMembership,type ClassRpc,
  type ClassTask} from '../../src/web/class-store';
import {draftFrom,emptyDraft,draftProblem,reconcileVariables,saveDraft,selectableTasks,
  prepareOutputImage,addTextOutput,addImageOutput,removeOutput,LIMITS,
  type Draft,type Raster,type SaveMode} from '../../src/web/class-editor';

/** 上傳的照片可能是 iPad 拍的 4000px 原圖，一律在瀏覽器端縮好再送。 */
async function rasterFromFile(file:File):Promise<Raster>{
  const bitmap=await createImageBitmap(file);
  return {width:bitmap.width,height:bitmap.height,
    async toJpeg(width,height,quality){
      const canvas=document.createElement('canvas');
      canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d');
      if(!context)throw new Error('這個瀏覽器沒辦法處理圖片，請換一台試試');
      context.drawImage(bitmap,0,0,width,height);
      return canvas.toDataURL('image/jpeg',quality);
    }};
}

type Props={
  rpc:ClassRpc;
  membership:ClassMembership;
  tasks:ClassTask[];
  card:ClassCard|null;          // null 就是新增
  defaultTaskId:string|null;    // 從列表帶過來的任務，新增時先選好
  onClose(changed:boolean):void;
};

export default function ClassEditor({rpc,membership,tasks,card,defaultTaskId,onClose}:Props){
  const mine=card===null||isMine(card,membership);
  const [saved,setSaved]=useState<ClassCard|null>(card);
  const [draft,setDraft]=useState<Draft>(()=>card?draftFrom(card,'edit'):emptyDraft(defaultTaskId));
  const [mode,setMode]=useState<SaveMode>(card?'edit':'new');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [changed,setChanged]=useState(false);
  const bodyField=useRef<HTMLTextAreaElement>(null);
  const touched=useRef(false);

  useEffect(()=>{if(!card)bodyField.current?.focus();},[card]);

  // 列表的卡片只帶得到圖片輸出，開起來要換成完整的那一筆，
  // 但如果人已經開始打字就不要蓋掉他寫的東西。
  useEffect(()=>{
    if(!card)return;
    let live=true;
    fetchVersions(rpc,membership.class_id,card.group_id).then(rows=>{
      const full=rows.find(r=>r.id===card.id);
      if(!live||!full||touched.current)return;
      setSaved(full);setDraft(draftFrom(full,'edit'));
    }).catch(()=>{});
    return ()=>{live=false;};
  },[rpc,membership.class_id,card]);

  // 本文一改，變數清單就跟著重算——伺服器要求兩者完全一致
  const edit=useCallback((patch:Partial<Draft>)=>{touched.current=true;setDraft(d=>{
    const next={...d,...patch};
    return patch.body===undefined?next:{...next,variables:reconcileVariables(patch.body,d.variables)};
  });},[]);

  const problem=draftProblem(draft,mode);
  const options=useMemo(()=>selectableTasks(tasks,draft.taskId),[tasks,draft.taskId]);

  const save=async()=>{
    setBusy(true);setError('');
    try{
      const result=await saveDraft(rpc,draft,membership.class_id,mode);
      setSaved(result);setChanged(true);
      // 存過之後就變成「改這一版」，不然連按兩次會生出兩筆
      setDraft(draftFrom(result,'edit'));setMode('edit');
    }catch(e){setError((e as Error).message);}
    finally{setBusy(false);}
  };

  return <section className="class-editor">
    <div className="class-editor-bar">
      <button className="text-link" onClick={()=>onClose(changed)}><ArrowLeft size={15}/>回列表</button>
      {saved&&<span className="class-version">V{saved.version_no}</span>}
      {!mine&&<span className="class-readonly">別人的 Prompt，只能看</span>}
    </div>

    {error&&<div className="class-error" role="alert">{error}</div>}

    <fieldset disabled={!mine||busy} className="class-form">
      <label className="class-field">
        <span>標題</span>
        <input value={draft.title} maxLength={LIMITS.title} placeholder="一句話說這個 Prompt 在做什麼"
          onChange={e=>edit({title:e.target.value})}/>
      </label>

      <label className="class-field">
        <span>本文</span>
        <textarea ref={bodyField} value={draft.body} rows={12}
          placeholder={'把要交代的事寫清楚：角色、任務、格式、限制。\n要讓別人換掉的地方寫成 {{這樣}}。'}
          onChange={e=>edit({body:e.target.value})}/>
        <small className="class-hint">{draft.body.length} / {LIMITS.body} 字</small>
      </label>

      {draft.variables.length>0&&<div className="class-field">
        <span>變數</span>
        <p className="class-hint">本文裡的 {'{{ }}'} 會變成這些欄位，填個範例讓別人知道要放什麼。</p>
        <div className="class-vars-edit">{draft.variables.map((v,i)=>
          <div className="class-var-row" key={v.name}>
            <code>{v.name}</code>
            <input value={v.example} placeholder="範例" aria-label={`${v.name} 的範例`}
              onChange={e=>setDraft(d=>({...d,variables:d.variables.map((x,j)=>
                j===i?{...x,example:e.target.value}:x)}))}/>
          </div>)}</div>
      </div>}

      <div className="class-two-up">
        <label className="class-field">
          <span>任務</span>
          <select value={draft.taskId??''} onChange={e=>edit({taskId:e.target.value||null})}>
            <option value="">不屬於任何任務</option>
            {options.map(t=><option key={t.id} value={t.id}>{t.title}{t.closed?'（已截止）':''}</option>)}
          </select>
        </label>
        <label className="class-field">
          <span>說明<em>（留白會自動產生）</em></span>
          <input value={draft.summary} maxLength={LIMITS.summary} placeholder="留白就自動產生一句"
            onChange={e=>edit({summary:e.target.value})}/>
        </label>
      </div>

      {mode==='version'&&<label className="class-field class-note-field">
        <span>這一版改了什麼、為什麼</span>
        <textarea value={draft.versionNote} rows={3} maxLength={LIMITS.note}
          placeholder="例如：加上「用國中生看得懂的話」，因為第一版的解釋太難。"
          onChange={e=>edit({versionNote:e.target.value})}/>
        <small className="class-hint">改版一定要寫，之後比較兩版時看的就是這句。</small>
      </label>}

      {mine&&<div className="class-actions">
        <Button onClick={()=>void save()} disabled={busy||problem!==null} className="class-big">
          {busy?<LoaderCircle size={18} className="spin"/>:<Save size={18}/>}
          {mode==='version'?'存成新版本':mode==='edit'?'儲存修改':'儲存'}
        </Button>
        {saved&&mode!=='version'&&<button className="text-link"
          onClick={()=>{setMode('version');setDraft(d=>({...d,versionNote:''}));}}>
          <GitBranch size={14}/>改成新版本（保留這一版）</button>}
        {mode==='version'&&<button className="text-link"
          onClick={()=>{setMode('edit');setError('');}}>取消改版，回到修改這一版</button>}
        {problem&&<small className="class-hint">{problem}</small>}
      </div>}
    </fieldset>

    {saved&&<Outputs rpc={rpc} classId={membership.class_id} prompt={saved} canEdit={mine}
      onChanged={updated=>{setSaved(updated);setChanged(true);}}/>}
  </section>;
}

function Outputs({rpc,classId,prompt,canEdit,onChanged}:{rpc:ClassRpc;classId:string;
    prompt:ClassCard;canEdit:boolean;onChanged(card:ClassCard):void}){
  const [text,setText]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [open,setOpen]=useState<'text'|null>(null);
  const picker=useRef<HTMLInputElement>(null);
  const outputs=prompt.outputs??[];
  const full=outputs.length>=LIMITS.outputsPerVersion;

  const after=(update:(list:ClassCard['outputs'])=>ClassCard['outputs'])=>
    onChanged({...prompt,outputs:update(outputs)});

  const run=async(work:()=>Promise<void>)=>{
    setBusy(true);setError('');
    try{await work();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };

  const addText=()=>run(async()=>{
    const created=await addTextOutput(rpc,classId,prompt.id,text) as {id:string};
    after(list=>[...list,{id:created.id,kind:'text',text_body:text.trim(),
      member_id:prompt.member_id,created_at:new Date().toISOString()}]);
    setText('');setOpen(null);
  });

  const addImage=(file:File)=>run(async()=>{
    const image=await prepareOutputImage(await rasterFromFile(file));
    const created=await addImageOutput(rpc,classId,prompt.id,image) as {id:string};
    after(list=>[...list,{id:created.id,kind:'image',image_thumb:image.image_thumb,
      member_id:prompt.member_id,created_at:new Date().toISOString()}]);
  });

  const drop=(id:string)=>run(async()=>{
    await removeOutput(rpc,classId,id);
    after(list=>list.filter(o=>o.id!==id));
  });

  return <section className="class-outputs">
    <h2>這個 Prompt 跑出來的結果</h2>
    <p className="class-hint">貼上模型真的回你的東西，同學才知道這個 Prompt 好在哪裡。</p>

    {error&&<div className="class-error" role="alert">{error}</div>}

    {outputs.length>0&&<ul className="class-output-list">{outputs.map(o=>
      <li key={o.id} className="class-output">
        {o.kind==='image'
          ? <img src={asDataUrl(o.image_thumb)??''} alt="這個 Prompt 產生的圖片" loading="lazy"/>
          : <p>{o.text_body}</p>}
        {canEdit&&<button className="text-link" onClick={()=>void drop(o.id)} disabled={busy}
          aria-label="刪掉這筆結果"><Trash2 size={14}/></button>}
      </li>)}</ul>}

    {canEdit&&<>
      <p className="class-warning"><TriangleAlert size={15}/>
        請不要上傳同學或任何真人的照片。</p>
      {open==='text'
        ? <div className="class-field">
            <textarea value={text} rows={6} autoFocus placeholder="把模型回你的內容貼在這裡"
              onChange={e=>setText(e.target.value)}/>
            <div className="class-actions">
              <Button onClick={()=>void addText()} disabled={busy||!text.trim()}>加上去</Button>
              <button className="text-link" onClick={()=>{setOpen(null);setText('');}}>取消</button>
            </div>
          </div>
        : <div className="class-actions">
            <Button variant="outline" onClick={()=>setOpen('text')} disabled={busy||full}>
              <MessageSquarePlus size={17}/>貼上文字結果</Button>
            <Button variant="outline" onClick={()=>picker.current?.click()} disabled={busy||full}>
              {busy?<LoaderCircle size={17} className="spin"/>:<ImagePlus size={17}/>}上傳圖片</Button>
            <input ref={picker} type="file" accept="image/*" hidden
              onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void addImage(file);}}/>
          </div>}
      {full&&<small className="class-hint">一個版本最多 {LIMITS.outputsPerVersion} 筆結果，要再加就先刪掉一筆。</small>}
    </>}
  </section>;
}
