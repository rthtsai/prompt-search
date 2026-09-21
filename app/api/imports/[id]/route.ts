import {getApp} from '../../../../src/web/service';
import {guard,failure,ok} from '../../../../src/web/http';
export const runtime='nodejs';
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,ctx:Context) {try{guard(request);return ok(await getApp().job((await ctx.params).id));}catch(error){return failure(error);}}
export async function POST(request:Request,ctx:Context) {try{guard(request,true);return ok(await getApp().acceptImport((await ctx.params).id));}catch(error){return failure(error);}}
