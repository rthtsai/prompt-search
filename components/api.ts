export const cloudMode=process.env.NEXT_PUBLIC_STORAGE_MODE==='cloud';
export const pagesDemo=process.env.NEXT_PUBLIC_PAGES_DEMO==='true';
export async function api<T>(url:string,options:RequestInit={}):Promise<T> {if(cloudMode){const {cloudApi}=await import('../src/web/cloud-store');return cloudApi<T>(url,options);}if(pagesDemo){const {browserApi}=await import('../src/web/browser-store');return browserApi<T>(url,options);}const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});const result=await response.json();if(!response.ok) throw new Error(result.error??'暫時無法完成，請重試');return result;}
export async function uploadExample(id:string,file:File,caption:string,role?:'input'|'output'){
  if(!cloudMode) throw new Error('這個版本不支援上傳圖片');
  const {cloudAddExample}=await import('../src/web/cloud-store');
  return cloudAddExample(id,file,caption,role);
}
export async function uploadTextExample(id:string,text:string,caption:string){
  if(!cloudMode) throw new Error('這個版本不支援範例');
  const {cloudAddTextExample}=await import('../src/web/cloud-store');
  return cloudAddTextExample(id,text,caption);
}
