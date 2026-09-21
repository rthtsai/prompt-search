import {getApp} from '../../../src/web/service';
import {guard,failure,ok} from '../../../src/web/http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {try {guard(request);const q=new URL(request.url).searchParams;return ok(await getApp().library(q.get('q')??'',q.get('category')??'',q.get('sort')??'all',q.get('tag')??''));} catch(error){return failure(error);}}
