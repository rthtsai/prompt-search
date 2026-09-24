-- 007: 範例可以是短影片（教學用的操作錄影），不只是圖片、文件與文字。
-- 影片存在 Storage，和圖片、檔案一樣只存路徑；前端用 <video> 直接播。
BEGIN;

CREATE OR REPLACE FUNCTION public.shared_example_save(prompt_id uuid, entry jsonb, remove boolean DEFAULT false)
RETURNS public.prompt LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p public.prompt; kind text; path text; clean jsonb; ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 SELECT * INTO p FROM public.prompt WHERE id=prompt_id AND author_id=ws AND deleted_at IS NULL;
 IF p.id IS NULL THEN RAISE EXCEPTION '找不到這則 Prompt'; END IF;
 kind := coalesce(entry->>'kind','image');
 path := entry->>'path';
 IF length(coalesce(entry->>'caption','')) > 200 THEN RAISE EXCEPTION '範例說明最多 200 字'; END IF;

 IF remove THEN
  UPDATE public.prompt SET examples=coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(p.examples) e
    WHERE NOT (coalesce(e->>'id','')=coalesce(entry->>'id','') AND entry->>'id' IS NOT NULL)
      AND NOT (path IS NOT NULL AND e->>'path'=path)),'[]'::jsonb), updated_at=clock_timestamp()
   WHERE id=p.id RETURNING * INTO p;
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
  ELSIF kind='video' THEN
   IF path IS NULL OR path !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(mp4|webm)$' THEN RAISE EXCEPTION '影片路徑格式不正確'; END IF;
   IF entry->'size' IS NOT NULL AND (jsonb_typeof(entry->'size') <> 'number' OR (entry->>'size')::bigint NOT BETWEEN 1 AND 26214400)
    THEN RAISE EXCEPTION '影片大小需在 25 MB 以內'; END IF;
  ELSIF kind='file' THEN
   IF path IS NULL OR path !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(pdf|docx|xlsx|pptx|txt|md|csv|json)$' THEN RAISE EXCEPTION '檔案路徑格式不正確'; END IF;
   IF length(coalesce(entry->>'name','')) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION '檔名長度不正確'; END IF;
   IF entry->'size' IS NOT NULL AND (jsonb_typeof(entry->'size') <> 'number' OR (entry->>'size')::bigint NOT BETWEEN 1 AND 10485760)
    THEN RAISE EXCEPTION '檔案大小不正確'; END IF;
  ELSE RAISE EXCEPTION '不支援的範例類型'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p.examples) e WHERE e->>'path'=path) THEN RAISE EXCEPTION '這個檔案已經加過了'; END IF;
  clean := jsonb_strip_nulls(jsonb_build_object('id',gen_random_uuid(),'kind',kind,'path',path,
    'name',left(coalesce(entry->>'name',''),120),'mime',left(coalesce(entry->>'mime',''),100),'size',entry->'size'));
 END IF;

 UPDATE public.prompt SET examples=p.examples || jsonb_build_array(
   clean || jsonb_build_object('caption',coalesce(entry->>'caption',''),'added_at',clock_timestamp())),
   updated_at=clock_timestamp()
  WHERE id=p.id RETURNING * INTO p;
 RETURN p;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_example_save(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;

COMMIT;
