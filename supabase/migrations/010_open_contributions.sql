-- ============================================================================
-- 010：只有「會讓內容消失」的操作才要 token
--
-- 008/009 把「改既有內容」全部關起來，結果加範例、補說明這些純粹是貢獻的動作
-- 也被擋在維護者模式後面，日常使用變得很煩。
--
-- 真正要保護的是「內容會不見」：刪除、批次刪除、移除範例、合併、分類改寫，
-- 以及 edit——因為把每一則改成一個字，效果跟刪光一樣。
-- 補說明（example_caption）不會讓任何東西消失，所以放開。
--
-- ⚠️ 本檔會重建 prompt_library，內容包含 008 的全部閘門邏輯；
--    若重跑 003 或 005，請依序再跑 008、009。
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.prompt_library(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE op text := request->>'op'; token text := request->>'maintainer'; n integer; p public.prompt;
 ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 IF op IN ('delete','delete_many','merge','categories_save','example_remove',
           'edit','restore','restore_many') THEN
  IF NOT public.shared_is_maintainer(token)
   THEN RAISE EXCEPTION '這個操作保留給維護者。你仍然可以新增、另存一份與複製。'; END IF;
 END IF;

 IF op='restore' THEN
  UPDATE public.prompt SET deleted_at=NULL, updated_at=clock_timestamp()
   WHERE id=(request->>'id')::uuid AND author_id=ws AND deleted_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=0 THEN RAISE EXCEPTION '已經來不及復原了，請重新載入看看'; END IF;
  RETURN jsonb_build_object('restored',true,'id',(request->>'id')::uuid);
 END IF;
 IF op='restore_many' THEN
  UPDATE public.prompt SET deleted_at=NULL, updated_at=clock_timestamp()
   WHERE id = ANY(public.shared_uuid_list(request->'ids')) AND author_id=ws AND deleted_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('restored',n);
 END IF;

 -- 改某一個範例的說明。舊資料有些沒有 id，所以也接受用 path 指認。
 IF op='example_caption' THEN
  IF length(coalesce(request->>'caption','')) > 200 THEN RAISE EXCEPTION '範例說明最多 200 字'; END IF;
  IF coalesce(request->>'entry_id','')='' AND coalesce(request->>'path','')=''
   THEN RAISE EXCEPTION '缺少要修改的範例'; END IF;
  UPDATE public.prompt SET examples=coalesce((
     SELECT jsonb_agg(CASE
       WHEN (request->>'entry_id' IS NOT NULL AND e->>'id' = request->>'entry_id')
         OR (request->>'path' IS NOT NULL AND e->>'path' = request->>'path')
       THEN e || jsonb_build_object('caption', left(coalesce(request->>'caption',''),200))
       ELSE e END ORDER BY ord)
     FROM jsonb_array_elements(examples) WITH ORDINALITY AS t(e,ord)),'[]'),
   updated_at=clock_timestamp()
   WHERE id=(request->>'id')::uuid AND author_id=ws AND deleted_at IS NULL
   RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt，請重新整理'; END IF;
  RETURN public.shared_prompt_card(p);
 END IF;

 RETURN public.prompt_library_impl(request - 'maintainer');
END;
$$;
REVOKE ALL ON FUNCTION public.prompt_library(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prompt_library(jsonb) TO anon, authenticated;

COMMIT;
