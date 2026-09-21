import {getApp} from '../../../../src/web/service';
import {guard,body,failure,ok} from '../../../../src/web/http';
export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
export async function POST(request:Request,ctx:Context) {
  try {
    guard(request,true);const input=await body(request),id=(await ctx.params).id;
    if(input.action==='use') {
      if(!input.values||typeof input.values!=='object'||Array.isArray(input.values)||Object.values(input.values).some(v=>typeof v!=='string')||JSON.stringify(input.values).length>100000) throw new Error('變數內容格式錯誤');
      return ok(await getApp().used(id,input.values,input.eventId));
    }
    if(input.action==='edit') {
      if(['title','body','summary','category'].some(k=>typeof input[k]!=='string')||input.body.length>24000) throw new Error('範本格式錯誤');
      return ok(await getApp().edit(id,{title:input.title,body:input.body,summary:input.summary,category:input.category,fork:input.fork===true}));
    }
    throw new Error('不支援的操作');
  }catch(error){return failure(error);}
}
