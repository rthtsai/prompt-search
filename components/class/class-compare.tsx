'use client';
// 比較頁：同一個任務，把每個人的每一版並排。重點不是誰寫得好，
// 而是「改了什麼、為什麼」——所以版本說明排在本文前面。
import {useEffect,useState} from 'react';
import {ArrowLeft,LoaderCircle,Star,Image as ImageIcon} from 'lucide-react';
import {fetchCompare,compareDepth,versionAt,latestVersion,toggleFeatured,isStaff,asDataUrl,
  type ClassMembership,type ClassRpc,type CompareResult} from '../../src/web/class-store';

export default function ClassCompare({rpc,membership,taskId,onBack}:{rpc:ClassRpc;
    membership:ClassMembership;taskId:string;onBack():void}){
  const [data,setData]=useState<CompareResult|null>(null);
  const [error,setError]=useState('');
  const [latestOnly,setLatestOnly]=useState(false);
  const staff=isStaff(membership);

  useEffect(()=>{
    let live=true;setData(null);setError('');
    fetchCompare(rpc,membership.class_id,taskId)
      .then(r=>{if(live)setData(r);})
      .catch(e=>{if(live)setError((e as Error).message);});
    return ()=>{live=false;};
  },[rpc,membership.class_id,taskId]);

  const star=async(id:string)=>{
    try{
      const result=await toggleFeatured(rpc,membership.class_id,id);
      setData(d=>d&&{...d,columns:d.columns.map(c=>({...c,
        versions:(c.versions??[]).map(v=>v.id===id?{...v,featured:result.featured}:v)}))});
    }catch(e){setError((e as Error).message);}
  };

  const depth=data?compareDepth(data):0;
  const rows=latestOnly?[-1]:Array.from({length:depth},(_,i)=>i);

  return <section className="prompts-section class-compare">
    <div className="class-editor-bar">
      <button className="text-link" onClick={onBack}><ArrowLeft size={15}/>回任務</button>
      {depth>1&&<label className="class-hint class-latest">
        <input type="checkbox" checked={latestOnly} onChange={e=>setLatestOnly(e.target.checked)}/>
        只看最新版</label>}
    </div>

    {error&&<div className="class-error" role="alert">{error}</div>}
    {data===null&&!error&&<div className="empty-state"><span className="empty-icon">
      <LoaderCircle size={26} className="spin"/></span><h3>載入中</h3></div>}

    {data&&<>
      <h2>{data.task.title}</h2>
      {data.task.description&&<p className="class-hint">{data.task.description}</p>}
      {/* 橫向捲動而不是擠成很多欄；iPad 上一次看兩三個人剛好 */}
      <div className="class-compare-scroll">
        <div className="class-compare-grid" style={{gridTemplateColumns:`repeat(${data.columns.length},minmax(260px,1fr))`}}>
          {data.columns.map(c=><div className="class-compare-head" key={'h'+c.member_id}>
            <strong>{c.author??'（未命名）'}</strong>{c.team&&<span className="class-team">{c.team}</span>}
          </div>)}
          {rows.map(i=>data.columns.map(c=>{
            const v=i<0?latestVersion(c):versionAt(c,i);
            return <div className="class-compare-cell" key={c.member_id+'-'+i}>
              {v?<>
                <div className="class-card-top">
                  <span className="class-version">V{v.version_no}</span>
                  {v.outputs?.some(o=>o.kind==='image')&&<span className="class-hint"><ImageIcon size={12}/></span>}
                  {staff&&<button className={v.featured?'class-star on':'class-star'}
                    onClick={()=>void star(v.id)} aria-pressed={v.featured}
                    aria-label={v.featured?'取消精選':'設為精選'}><Star size={14}/></button>}
                </div>
                {v.version_note&&<p className="class-note">{v.version_note}</p>}
                <pre>{v.body}</pre>
                {v.outputs?.filter(o=>o.kind==='image'&&o.image_thumb).slice(0,1).map(o=>
                  <img key={o.id} src={asDataUrl(o.image_thumb)??''} alt="" loading="lazy"/>)}
              </>:<span className="class-hint">（沒有這一版）</span>}
            </div>;
          }))}
        </div>
      </div>
    </>}
  </section>;
}
