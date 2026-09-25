'use client';
// 教師台：核可加入、分組、班級代碼、匯出。學生看不到這一頁（伺服器也會再擋一次）。
import {useCallback,useEffect,useState} from 'react';
import {Check,Download,KeyRound,LoaderCircle,RefreshCw,UserMinus,Users} from 'lucide-react';
import {Button} from '../ui/button';
import {fetchRoster,splitRoster,memberOp,assignTeam,createTeam,renameTeam,rotateCode,
  exportClass,exportFilename,
  type ClassMembership,type ClassRpc,type Roster} from '../../src/web/class-store';

export default function ClassRoster({rpc,membership,onTeams}:{rpc:ClassRpc;
    membership:ClassMembership;onTeams(teams:Roster['teams']):void}){
  const [roster,setRoster]=useState<Roster|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [newTeam,setNewTeam]=useState('');
  const [note,setNote]=useState('');

  const load=useCallback(()=>{
    setError('');
    fetchRoster(rpc,membership.class_id)
      .then(r=>{setRoster(r);onTeams(r.teams);})
      .catch(e=>setError((e as Error).message));
  },[rpc,membership.class_id,onTeams]);
  useEffect(()=>{setRoster(null);load();},[load]);

  const run=async(work:()=>Promise<unknown>)=>{
    setBusy(true);setError('');setNote('');
    try{await work();load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };

  const download=()=>run(async()=>{
    const data=await exportClass(rpc,membership.class_id);
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,1)],{type:'application/json'}));
    const link=document.createElement('a');
    link.href=url;link.download=exportFilename(membership.name);link.click();
    URL.revokeObjectURL(url);
    setNote('已下載，檔案裡沒有信箱和姓名。');
  });

  if(!roster)return <section className="prompts-section">
    {error?<div className="class-error" role="alert">{error}</div>
      :<div className="empty-state"><span className="empty-icon">
        <LoaderCircle size={26} className="spin"/></span><h3>載入中</h3></div>}
  </section>;

  const {pending,active}=splitRoster(roster);

  return <section className="prompts-section class-roster">
    {error&&<div className="class-error" role="alert">{error}</div>}
    {note&&<p className="class-hint">{note}</p>}

    <div className="class-section-head">
      <h2><KeyRound size={18}/>班級代碼</h2>
      <code className="class-code-show">{roster.class.code}</code>
      <button className="text-link" disabled={busy}
        onClick={()=>void run(()=>rotateCode(rpc,membership.class_id))}>
        <RefreshCw size={13}/>換一組</button>
    </div>
    <p className="class-hint">換掉之後舊代碼立刻失效，已經加入的人不受影響。
      目前 {active.length} / {roster.class.max_members} 人。</p>

    {pending.length>0&&<>
      <div className="class-section-head"><h2>等你核可（{pending.length}）</h2></div>
      <ul className="class-member-list">{pending.map(m=>
        <li className="class-member" key={m.id}>
          <div><strong>{m.full_name??'（沒有名字）'}</strong><small>{m.email}</small></div>
          <div className="class-actions">
            <Button disabled={busy} onClick={()=>void run(()=>memberOp('approve',rpc,membership.class_id,m.id))}>
              <Check size={16}/>讓他進來</Button>
            <button className="text-link" disabled={busy}
              onClick={()=>void run(()=>memberOp('reject',rpc,membership.class_id,m.id))}>拒絕</button>
          </div>
        </li>)}</ul>
    </>}

    <div className="class-section-head">
      <h2><Users size={18}/>分組</h2>
      <form onSubmit={e=>{e.preventDefault();
        void run(async()=>{await createTeam(rpc,membership.class_id,newTeam);setNewTeam('');});}}>
        <input value={newTeam} placeholder="新增一組，例如 第一組" maxLength={40}
          aria-label="新組別名稱" onChange={e=>setNewTeam(e.target.value)}/>
      </form>
    </div>
    {roster.teams.length>0&&<ul className="class-team-list">{roster.teams.map(t=>
      <li key={t.id}>
        <input defaultValue={t.name} maxLength={40} aria-label={`${t.name} 的名稱`}
          onBlur={e=>{const value=e.target.value.trim();
            if(value&&value!==t.name)void run(()=>renameTeam(rpc,membership.class_id,t.id,value));}}/>
        <span className="class-hint">{active.filter(m=>m.team_id===t.id).length} 人</span>
      </li>)}</ul>}

    <div className="class-section-head"><h2>班上的人（{active.length}）</h2>
      <button className="text-link" disabled={busy} onClick={download}><Download size={13}/>匯出</button></div>
    <ul className="class-member-list">{active.map(m=>
      <li className="class-member" key={m.id}>
        <div><strong>{m.nickname??'（還沒取暱稱）'}</strong>
          <small>{m.email}{m.role!=='student'&&`・${m.role==='teacher'?'老師':'助教'}`}</small></div>
        <div className="class-actions">
          <select value={m.team_id??''} aria-label={`${m.nickname??'這個人'}的組別`} disabled={busy}
            onChange={e=>void run(()=>assignTeam(rpc,membership.class_id,m.id,e.target.value||null))}>
            <option value="">沒有分組</option>
            {roster.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {m.nickname!==membership.nickname&&<button className="text-link" disabled={busy}
            onClick={()=>void run(()=>memberOp('remove_member',rpc,membership.class_id,m.id))}
            aria-label={`把 ${m.nickname??'這個人'} 移出班級`}><UserMinus size={14}/></button>}
        </div>
      </li>)}</ul>
  </section>;
}
