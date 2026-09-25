'use client';
// 任務頁：老師出題、看誰交了、關閉任務；學生從這裡進去寫，或看全班怎麼寫。
import {useCallback,useEffect,useState} from 'react';
import {ClipboardList,LoaderCircle,Lock,Plus,Users,ArrowRight} from 'lucide-react';
import {Button} from '../ui/button';
import {fetchTasks,createTask,closeTask,isStaff,
  type ClassMembership,type ClassRpc,type RosterTeam,type TaskDetail} from '../../src/web/class-store';

type Props={rpc:ClassRpc;membership:ClassMembership;teams:RosterTeam[];
  onWrite(taskId:string):void;onCompare(task:TaskDetail):void};

export default function ClassTasks({rpc,membership,teams,onWrite,onCompare}:Props){
  const [tasks,setTasks]=useState<TaskDetail[]|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [writing,setWriting]=useState(false);
  const [title,setTitle]=useState('');
  const [description,setDescription]=useState('');
  const [teamId,setTeamId]=useState<string|null>(null);
  const staff=isStaff(membership);

  const load=useCallback(()=>{
    setError('');
    fetchTasks(rpc,membership.class_id).then(setTasks).catch(e=>setError((e as Error).message));
  },[rpc,membership.class_id]);
  useEffect(()=>{setTasks(null);load();},[load]);

  const run=async(work:()=>Promise<unknown>)=>{
    setBusy(true);setError('');
    try{await work();load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };

  return <section className="prompts-section class-tasks">
    <div className="class-section-head">
      <h2><ClipboardList size={18}/>任務</h2>
      {(staff||membership.team_id)&&!writing&&
        <Button variant="outline" onClick={()=>{setWriting(true);setTeamId(staff?null:membership.team_id);}}>
          <Plus size={17}/>出一個任務</Button>}
    </div>

    {error&&<div className="class-error" role="alert">{error}</div>}

    {writing&&<form className="class-form class-task-form" onSubmit={e=>{e.preventDefault();
      void run(async()=>{await createTask(rpc,membership.class_id,{title,description,teamId});
        setTitle('');setDescription('');setWriting(false);});}}>
      <label className="class-field"><span>題目</span>
        <input value={title} maxLength={120} autoFocus placeholder="例如：把一段新聞改寫給國中生看"
          onChange={e=>setTitle(e.target.value)}/></label>
      <label className="class-field"><span>說明<em>（可留白）</em></span>
        <textarea value={description} rows={3} maxLength={2000}
          placeholder="要達成什麼、交出來要長什麼樣子"
          onChange={e=>setDescription(e.target.value)}/></label>
      {staff&&teams.length>0&&<label className="class-field"><span>給誰</span>
        <select value={teamId??''} onChange={e=>setTeamId(e.target.value||null)}>
          <option value="">全班</option>
          {teams.map(t=><option key={t.id} value={t.id}>只給 {t.name}</option>)}
        </select></label>}
      <div className="class-actions">
        <Button type="submit" disabled={busy||!title.trim()}>{busy?'送出中…':'出題'}</Button>
        <button type="button" className="text-link" onClick={()=>setWriting(false)}>取消</button>
      </div>
    </form>}

    {tasks===null&&!error&&<div className="empty-state"><span className="empty-icon">
      <LoaderCircle size={26} className="spin"/></span><h3>載入中</h3></div>}
    {tasks?.length===0&&<div className="empty-state"><span className="empty-icon"><ClipboardList size={26}/></span>
      <h3>還沒有任務</h3><p>{staff?'出一個題目，大家寫的東西就會集中在這裡。':'等老師出題。'}</p></div>}

    {!!tasks?.length&&<ul className="class-task-list">{tasks.map(t=>
      <li key={t.id} className={t.closed?'class-task closed':'class-task'}>
        <div className="class-task-top">
          <h3>{t.title}</h3>
          {t.team&&<span className="class-team">{t.team}</span>}
          {t.closed&&<span className="class-closed"><Lock size={12}/>已截止</span>}
        </div>
        {t.description&&<p>{t.description}</p>}
        <div className="class-task-bottom">
          <span><Users size={13}/>{t.handed_in} 人交了</span>
          {!t.closed&&<button className="text-link" onClick={()=>onWrite(t.id)}>
            我要寫<ArrowRight size={13}/></button>}
          {t.handed_in>0&&<button className="text-link" onClick={()=>onCompare(t)}>
            看大家怎麼寫<ArrowRight size={13}/></button>}
          {!t.closed&&staff&&<button className="text-link" disabled={busy}
            onClick={()=>void run(()=>closeTask(rpc,membership.class_id,t.id))}>
            <Lock size={13}/>截止</button>}
        </div>
      </li>)}</ul>}
  </section>;
}
