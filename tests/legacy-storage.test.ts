import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {collectLegacy,readIndexedDBSnapshot,CLOUD_CACHE_KEY} from '../src/web/legacy-storage.ts';
import {migrateSnapshots} from '../src/web/cloud-store.ts';
import {organizeBrowser} from '../src/web/browser-store.ts';
const card=()=>organizeBrowser('請整理這篇文章的重點，輸出摘要、主要論點與可執行的下一步行動。','test');
const dbOpen=()=>new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('prompt-dictionary-pages-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
async function put(prompts:unknown[]){const db=await dbOpen();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put({prompts,jobs:{},events:['keep']},'library');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();}
test('實際 IndexedDB 遷移：網路失敗保留、成功清空收藏但保留其他欄位',async()=>{
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
 await put([card()]);let snapshot=await readIndexedDBSnapshot();assert.ok(snapshot);
 await migrateSnapshots([snapshot],async()=>{throw Error('offline');});assert.equal((await readIndexedDBSnapshot())?.items.length,1);
 await migrateSnapshots([snapshot],async(r:any)=>r.items);assert.equal(await readIndexedDBSnapshot(),null);
 const db=await dbOpen();const result=await new Promise<any>(resolve=>{const req=db.transaction('state').objectStore('state').get('library');req.onsuccess=()=>resolve(req.result);});assert.deepEqual(result.events,['keep']);db.close();
});
test('IndexedDB 遷移期间另一分頁新增時不清除',async()=>{
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});await put([card()]);const snapshot=await readIndexedDBSnapshot();await put([card(),card()]);
 const result=await migrateSnapshots([snapshot!],async(r:any)=>r.items);assert.equal(result.errors.length,1);assert.equal((await readIndexedDBSnapshot())?.items.length,2);
});
test('localStorage 僅讀已知舊版鍵，快取不會再次上傳；成功才清掉原鍵',async()=>{
 Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});
 const local:any={prompts:JSON.stringify([card()]),'prompt-search-old':'broken',[CLOUD_CACHE_KEY]:JSON.stringify({prompts:[card()]}),unrelated:'keep'};
 Object.defineProperties(local,{getItem:{value:(k:string)=>local[k]??null},removeItem:{value:(k:string)=>delete local[k]}});
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:local});
 const source=await collectLegacy();assert.equal(source.snapshots.length,1);assert.equal(source.errors.length,1);
 await migrateSnapshots(source.snapshots,async(r:any)=>r.items);assert.equal(local.prompts,undefined);assert.equal(local.unrelated,'keep');assert.equal(local['prompt-search-old'],'broken');assert.ok(local[CLOUD_CACHE_KEY]);
});
