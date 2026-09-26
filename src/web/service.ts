import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../memory-store.ts';
import { DemoAI } from '../ai.ts';
import { fixtures, DEMO_USER } from '../fixtures.ts';
import { CATEGORIES, type Prompt, type Usage, validateExtracted, searchable, structuralQuality } from '../domain.ts';
import { SearchService } from '../search.ts';
import { prepareImport, type ImportPreview } from '../importer.ts';
import { fingerprint,simhash } from '../text.ts';
import { type CardPrompt,type ImportJob,type Library,fillTemplate ,categoryStats} from './types.ts';

type Data = {version:1;prompts:Prompt[];usages:Usage[];events:string[];acceptedJobs:string[]};
type InternalJob = ImportJob & {preview?:ImportPreview};
export class LocalApp {
  private directory:string; private store=new MemoryStore(); private ai=new DemoAI();
  private initialized:Promise<void>|null=null; private queue:Promise<unknown>=Promise.resolve();
  private events:string[]=[]; private acceptedJobs:string[]=[]; private jobs=new Map<string,InternalJob>();
  private searchService=new SearchService(this.store,this.ai);
  constructor(directory:string) {this.directory=directory;}
  private async atomic(name:string,value:unknown) {
    await mkdir(this.directory,{recursive:true});
    const file=join(this.directory,name), temp=file+'.'+randomUUID()+'.tmp';
    await writeFile(temp,JSON.stringify(value),{mode:0o600}); await rename(temp,file);
  }
  private init() {
    if(!this.initialized) this.initialized=(async()=>{
      try {
        const data:Data=JSON.parse(await readFile(join(this.directory,'library.json'),'utf8'));
        if(data.version!==1||!Array.isArray(data.prompts)||!Array.isArray(data.usages)) throw new Error('本機資料格式不正確，請保留檔案並檢查');
        this.store=new MemoryStore(data.prompts,data.usages);this.events=data.events??[];this.acceptedJobs=data.acceptedJobs??[];
      } catch(error:any) {
        if(error.code!=='ENOENT') throw error;
        this.store=new MemoryStore(await fixtures(this.ai)); await this.persist();
      }
      this.searchService=new SearchService(this.store,this.ai);
    })();
    return this.initialized;
  }
  private persist() {return this.atomic('library.json',{version:1,prompts:this.store.prompts,usages:this.store.usages,events:this.events,acceptedJobs:this.acceptedJobs} satisfies Data);}
  private async mutate<T>(operation:()=>Promise<T>):Promise<T> {
    await this.init();
    const pending=this.queue.then(async()=>{
      const before=structuredClone({prompts:this.store.prompts,usages:this.store.usages,events:this.events,acceptedJobs:this.acceptedJobs});
      try { const result=await operation(); await this.persist(); return result; }
      catch(error) {Object.assign(this.store,{prompts:before.prompts,usages:before.usages});this.events=before.events;this.acceptedJobs=before.acceptedJobs;throw error;}
    });
    this.queue=pending.catch(()=>{});return pending;
  }
  private card(p:Prompt):CardPrompt {
    const latest=this.store.usages.filter(u=>u.prompt_id===p.id).map(u=>u.used_at).sort().at(-1)??null;
    return {id:p.id,title:p.title,body:p.body,summary:p.summary,category:p.category,tags:p.tags,variables:p.variables,model_hint:p.model_hint,use_count:p.use_count,last_used:latest,source:p.source,fork_of:p.fork_of,updated_at:p.updated_at};
  }
  async library(query='',category='',sort='all',tag=''):Promise<Library> {
    await this.init();await this.queue;
    const all=this.store.prompts.filter(p=>p.state==='active'&&p.author_id===DEMO_USER);
    let items:CardPrompt[];let degraded=false;
    if(query.trim()) {
      const result=await this.searchService.search(DEMO_USER,query,{category:category||undefined,tag:tag||undefined});degraded=result.degraded;
      items=result.results.map(r=>({...this.card(all.find(p=>p.id===r.id)!),highlight:r.highlight}));
    } else items=all.filter(p=>(!category||p.category===category)&&(!tag||p.tags.includes(tag))).map(p=>this.card(p));
    if(sort==='recent') items=items.filter(p=>p.last_used).sort((a,b)=>(b.last_used??'').localeCompare(a.last_used??''));
    else if(sort==='popular') items.sort((a,b)=>b.use_count-a.use_count);
    else if(!query) items.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
    return {items,total:all.length,uses:all.reduce((n,p)=>n+p.use_count,0),categories:categoryStats(CATEGORIES.map(name=>({name})),all),tags:[...new Set(all.flatMap(p=>p.tags))],mode:'local',degraded};
  }
  async used(id:string,values:Record<string,string>,eventId:string) {
    if(!/^[a-f0-9-]{36}$/i.test(eventId)) throw new Error('使用紀錄識別碼錯誤');
    return this.mutate(async()=>{
      const p=this.store.prompts.find(p=>p.id===id&&p.author_id===DEMO_USER&&p.state==='active');if(!p) throw new Error('找不到這個 Prompt');
      fillTemplate(p.body,p.variables,values);
      if(!this.events.includes(eventId)) {
        p.use_count++;this.events.push(eventId);this.events=this.events.slice(-10000);
        this.store.usages.push({user_id:DEMO_USER,prompt_id:id,used_at:new Date().toISOString(),filled_vars:values});
      }
      return this.card(p);
    });
  }
  async edit(id:string,input:{title:string;body:string;summary:string;category:string;fork?:boolean}) {
    return this.mutate(async()=>{
      const current=this.store.prompts.find(p=>p.id===id&&p.author_id===DEMO_USER&&p.state==='active');if(!current) throw new Error('找不到這個 Prompt');
      const extracted=await this.ai.extract(input.body);
      extracted.title=input.title.trim();extracted.summary=input.summary.trim();extracted.category=input.category as Prompt['category'];
      extracted.variables=extracted.variables.map(v=>current.variables.find(old=>old.name===v.name)??v);validateExtracted(extracted);
      const hash=fingerprint(input.body);
      if(this.store.prompts.some(p=>p.id!==id&&p.normalized_hash===hash)||input.fork&&hash===current.normalized_hash) throw new Error('這份內容已在辭典裡，請修改內容後再儲存');
      const updated:Prompt={...current,...extracted,id:input.fork?randomUUID():current.id,fork_of:input.fork?current.id:current.fork_of,source_body:input.body,source:input.fork?'另存範本':current.source,normalized_hash:hash,simhash:simhash(input.body),embedding:await this.ai.embed(searchable(extracted)),quality_score:structuralQuality(extracted),updated_at:new Date().toISOString(),use_count:input.fork?0:current.use_count};
      if(input.fork) this.store.prompts.push(updated);else this.store.prompts[this.store.prompts.indexOf(current)]=updated;
      return this.card(updated);
    });
  }
  async startImport(text:string,source:string) {
    await this.init();
    if([...this.jobs.values()].filter(j=>j.status==='processing').length>=2) throw new Error('已有匯入正在進行，請稍候');
    const id=randomUUID();
    const job:InternalJob={id,status:'processing',done:0,total:0,items:[],duplicates:0,skipped:0,errors:[]};
    this.jobs.set(id,job);await this.atomic(`import-${id}.json`,job);
    void this.runImport(job,text,source);return this.publicJob(job);
  }
  private async runImport(job:InternalJob,text:string,source:string) {
    try {
      job.preview=await prepareImport(text,source,DEMO_USER,this.ai,this.store,(done,total)=>{job.done=done;job.total=total;});
      job.items=job.preview.prompts.filter(p=>p.state==='active').map(p=>this.card(p));
      job.skipped=job.preview.skipped;job.duplicates=job.preview.prompts.filter(p=>p.state==='duplicate').length;
      job.errors=job.preview.errors;job.status='review';
    } catch(error) {job.status='error';job.message=error instanceof Error?error.message:'匯入失敗';}
    await this.atomic(`import-${job.id}.json`,job).catch(()=>{job.status='error';job.message='無法儲存整理結果，請重新匯入';});
  }
  private publicJob(job:InternalJob):ImportJob {const {preview,...result}=job;return structuredClone(result);}
  private async findJob(id:string) {
    if(!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('匯入識別碼錯誤');
    await this.init();
    let job=this.jobs.get(id);
    if(!job) {
      try {job=JSON.parse(await readFile(join(this.directory,`import-${id}.json`),'utf8'));} catch {throw new Error('找不到這次匯入');}
      if(job!.status==='processing') {job!.status='error';job!.message='App 曾重新啟動，請重新匯入這個檔案';}
      this.jobs.set(id,job!);
    }
    if(this.acceptedJobs.includes(id)) job!.status='accepted';
    return job!;
  }
  async job(id:string) {return this.publicJob(await this.findJob(id));}
  async acceptImport(id:string) {
    const job=await this.findJob(id);
    await this.mutate(async()=>{
      if(this.acceptedJobs.includes(id)) return;
      if(job.status!=='review'||!job.preview) throw new Error('整理尚未完成，無法加入辭典');
      await this.store.accept(DEMO_USER,job.preview.prompts);this.acceptedJobs.push(id);
    });
    job.status='accepted';await this.atomic(`import-${id}.json`,job);return this.publicJob(job);
  }
}
const globalApp=globalThis as typeof globalThis & {promptSearchApp?:LocalApp};
export function getApp() {return globalApp.promptSearchApp??=new LocalApp(join(process.cwd(),'.data','web'));}
