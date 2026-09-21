export function guard(request:Request,write=false) {
  const host=request.headers.get('host')??new URL(request.url).host;
  if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new Error('這個版本僅開放本機使用');
  const origin=request.headers.get('origin');
  if(write&&origin&&new URL(origin).host!==host) throw new Error('不允許跨網站修改資料');
  if(write&&request.headers.get('sec-fetch-site')==='cross-site') throw new Error('不允許跨網站修改資料');
}
export async function body(request:Request):Promise<Record<string,any>> {
  const reader=request.body?.getReader();if(!reader) throw new Error('缺少內容');
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true) {const {done,value}=await reader.read();if(done) break;size+=value.length;if(size>11*1024*1024){await reader.cancel();throw new Error('檔案太大，最多 10 MB');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('資料格式錯誤');return data;
}
export const failure=(error:unknown)=>Response.json({error:error instanceof Error?error.message:'處理失敗，請重試'},{status:400,headers:{'Cache-Control':'no-store'}});
export const ok=(data:unknown)=>Response.json(data,{headers:{'Cache-Control':'no-store'}});
