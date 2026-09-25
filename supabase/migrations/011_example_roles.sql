-- ============================================================================
-- 011：範例分得出「輸入」和「產出」
--
-- 修圖類的 prompt，看到成品不會知道它做了什麼——要和原圖並排才看得懂。
-- 但範例本來只有 kind（image/file/text），沒有「這張是輸入還是產出」的概念，
-- 所以卡片封面只能挑「第一張圖」，上傳順序一反就會把原圖當封面。
--
-- 這裡在範例上加一個 role：'input'（原圖）或 'output'（產出，預設）。
-- 新增時可以帶，事後也能用 example_role 改。兩者都不會讓內容消失，所以不需要維護者權限。
--
-- 最後把既有資料回填：說明寫「原圖」的那些就是輸入。
--
-- ⚠️ 本檔會重建 prompt_library（含 008/010 的閘門）與 shared_example_save；
--    若重跑 003 或 005，請依序再跑 008、010、011。
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.shared_example_save(prompt_id uuid, entry jsonb, remove boolean DEFAULT false)
RETURNS public.prompt LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p public.prompt; kind text; path text; clean jsonb; ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '範例格式不正確'; END IF;
 kind := coalesce(entry->>'kind','image');
 path := entry->>'path';
 IF length(coalesce(entry->>'caption','')) > 200 THEN RAISE EXCEPTION '範例說明最多 200 字'; END IF;
 IF coalesce(entry->>'role','') NOT IN ('','input','output') THEN RAISE EXCEPTION '範例角色不正確'; END IF;
 SELECT * INTO p FROM public.prompt WHERE id=prompt_id AND author_id=ws AND deleted_at IS NULL FOR UPDATE;
 IF p.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt，請重新整理'; END IF;

 IF remove THEN
  IF path IS NULL AND entry->>'id' IS NULL THEN RAISE EXCEPTION '缺少要移除的範例'; END IF;
  UPDATE public.prompt SET examples=coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(examples) e
     WHERE e->>'path' IS DISTINCT FROM path AND (entry->>'id' IS NULL OR e->>'id' IS DISTINCT FROM entry->>'id')),'[]'),
    updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
  RETURN p;
 END IF;

 IF jsonb_array_length(p.examples) >= 6 THEN RAISE EXCEPTION '每則 Prompt 最多 6 個範例'; END IF;
 IF kind='text' THEN
  IF jsonb_typeof(entry->'text') IS DISTINCT FROM 'string' OR length(btrim(entry->>'text')) NOT BETWEEN 1 AND 8000
   THEN RAISE EXCEPTION '文字範例需為 1 到 8000 字'; END IF;
  clean := jsonb_build_object('id',gen_random_uuid(),'kind','text','text',entry->>'text');
 ELSE
  IF kind='image' THEN
   IF path IS NULL OR path !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$' THEN RAISE EXCEPTION '圖片路徑格式不正確'; END IF;
  ELSIF kind='file' THEN
   IF path IS NULL OR path !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(pdf|docx|xlsx|pptx|txt|md|csv|json)$' THEN RAISE EXCEPTION '檔案路徑格式不正確'; END IF;
   IF length(coalesce(entry->>'name','')) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION '檔名長度不正確'; END IF;
   IF entry->'size' IS NOT NULL AND (jsonb_typeof(entry->'size') <> 'number' OR (entry->>'size')::bigint NOT BETWEEN 1 AND 10485760)
    THEN RAISE EXCEPTION '檔案大小不正確'; END IF;
  ELSE RAISE EXCEPTION '不支援的範例類型'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p.examples) e WHERE e->>'path'=path) THEN RAISE EXCEPTION '這個檔案已經加過了'; END IF;
  clean := jsonb_strip_nulls(jsonb_build_object('id',gen_random_uuid(),'kind',kind,'path',path,
    'name',left(coalesce(entry->>'name',''),120),'mime',left(coalesce(entry->>'mime',''),100),'size',entry->'size',
    'role',nullif(lower(btrim(coalesce(entry->>'role',''))),'')));
 END IF;
 UPDATE public.prompt SET examples=p.examples || jsonb_build_array(
   clean || jsonb_build_object('caption',coalesce(entry->>'caption',''),'added_at',clock_timestamp())),
   updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
 RETURN p;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_example_save(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;

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

 -- 改某一個範例的說明或角色。舊資料有些沒有 id，所以也接受用 path 指認。
 IF op IN ('example_caption','example_role') THEN
  IF op='example_caption' AND length(coalesce(request->>'caption','')) > 200
   THEN RAISE EXCEPTION '範例說明最多 200 字'; END IF;
  IF op='example_role' AND coalesce(request->>'role','') NOT IN ('input','output')
   THEN RAISE EXCEPTION '範例角色不正確'; END IF;
  IF coalesce(request->>'entry_id','')='' AND coalesce(request->>'path','')=''
   THEN RAISE EXCEPTION '缺少要修改的範例'; END IF;
  UPDATE public.prompt SET examples=coalesce((
     SELECT jsonb_agg(CASE
       WHEN (request->>'entry_id' IS NOT NULL AND e->>'id' = request->>'entry_id')
         OR (request->>'path' IS NOT NULL AND e->>'path' = request->>'path')
       THEN e || CASE WHEN op='example_caption'
            THEN jsonb_build_object('caption', left(coalesce(request->>'caption',''),200))
            ELSE jsonb_build_object('role', request->>'role') END
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

-- 回填：說明是「原圖」的就是輸入，其餘的圖片當產出
UPDATE public.prompt SET examples=coalesce((
   SELECT jsonb_agg(CASE WHEN coalesce(e->>'kind','image')='image'
     THEN e || jsonb_build_object('role', CASE WHEN btrim(coalesce(e->>'caption',''))='原圖'
                                               THEN 'input' ELSE 'output' END)
     ELSE e END ORDER BY ord)
   FROM jsonb_array_elements(examples) WITH ORDINALITY AS t(e,ord)),'[]')
 WHERE deleted_at IS NULL AND jsonb_array_length(examples) > 0;

COMMIT;

SELECT count(*) FILTER (WHERE e->>'role'='input')  AS 標成原圖,
       count(*) FILTER (WHERE e->>'role'='output') AS 標成產出,
       count(*) FILTER (WHERE e->>'role' IS NULL)  AS 沒有角色
FROM public.prompt p, jsonb_array_elements(p.examples) e WHERE p.deleted_at IS NULL;
