import {getApp} from '../../../src/web/service';
import {guard,body,failure,ok} from '../../../src/web/http';
export const runtime='nodejs';
export async function POST(request:Request) {try {guard(request,true);const input=await body(request);if(typeof input.text!=='string'||typeof input.source!=='string'||input.source.length>300) throw new Error('請提供有效文字或檔案');return ok(await getApp().startImport(input.text,input.source));}catch(error){return failure(error);}}
