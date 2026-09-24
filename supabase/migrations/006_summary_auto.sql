-- Apply after 005. Marks a summary that the app generated from the body, so the
-- import screen can show it as "自動" and regenerate it, while anything the person
-- typed is left alone. The generator itself runs in the browser (src/web/describe.ts).
BEGIN;
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS summary_auto boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.shared_prompt_card(p public.prompt) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT jsonb_build_object('id',p.id,'title',p.title,'body',p.body,'body_en',p.body_en,'summary',p.summary,
 'category',(SELECT name FROM public.category WHERE id=p.category_id),'tags',p.tags,
 'variables',p.variables,'model_hint',p.model_hint,'use_count',p.use_count,'last_used',p.last_used,
 'source',p.source,'fork_of',p.fork_of,'updated_at',p.updated_at,'created_at',p.created_at,
 'group_id',coalesce(p.group_id,p.id),'version_no',p.version_no,'version_note',p.version_note,
 'examples',p.examples,'summary_auto',p.summary_auto);
$$;
REVOKE ALL ON FUNCTION public.shared_prompt_card(public.prompt) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.shared_prompt_save(item jsonb, editing_id uuid DEFAULT NULL, expected_version timestamptz DEFAULT NULL)
RETURNS public.prompt LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p public.prompt; cat uuid; h text; v jsonb; o jsonb; names text[]; placeholders text[]; en text; auto boolean;
BEGIN
 IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'body') IS DISTINCT FROM 'string'
 OR length(item->>'body') NOT BETWEEN 20 AND 24000 OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 160
 OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'summary') IS DISTINCT FROM 'string'
 OR length(item->>'summary') > 2000 OR jsonb_typeof(item->'variables') IS DISTINCT FROM 'array'
 OR jsonb_typeof(item->'tags') IS DISTINCT FROM 'array' OR jsonb_typeof(item->'model_hint') IS DISTINCT FROM 'array'
 OR (item ? 'body_en' AND jsonb_typeof(item->'body_en') NOT IN ('string','null'))
 OR (item ? 'version_note' AND jsonb_typeof(item->'version_note') IS DISTINCT FROM 'string')
 OR length(coalesce(item->>'version_note','')) > 200
 THEN RAISE EXCEPTION 'Prompt 格式或長度不正確'; END IF;
 auto := coalesce((item->>'summary_auto')::boolean,false);
 en := nullif(btrim(coalesce(item->>'body_en','')),'');
 IF en IS NOT NULL THEN en := item->>'body_en'; IF length(en) NOT BETWEEN 20 AND 24000 THEN RAISE EXCEPTION '英文版本長度需介於 20 到 24000 字'; END IF; END IF;
 IF jsonb_array_length(item->'variables') > 40 OR jsonb_array_length(item->'tags') > 20
 OR jsonb_array_length(item->'model_hint') > 20 THEN RAISE EXCEPTION '欄位數量過多'; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements((item->'tags') || (item->'model_hint')) LOOP
  IF jsonb_typeof(v) <> 'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION '標籤格式錯誤'; END IF;
 END LOOP;
 names := ARRAY[]::text[];
 FOR v IN SELECT value FROM jsonb_array_elements(item->'variables') LOOP
  IF jsonb_typeof(v) <> 'object' OR jsonb_typeof(v->'name') IS DISTINCT FROM 'string'
  OR length(v->>'name') NOT BETWEEN 1 AND 60 OR v->>'name' ~ '[{}\r\n]'
  OR jsonb_typeof(v->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'example') IS DISTINCT FROM 'string'
  OR jsonb_typeof(v->'required') IS DISTINCT FROM 'boolean' OR v->>'name'=ANY(names)
  OR (v ? 'type' AND coalesce(v->>'type','') NOT IN ('text','select','radio','number'))
  OR (v ? 'options' AND jsonb_typeof(v->'options') IS DISTINCT FROM 'array')
  THEN RAISE EXCEPTION '變數格式錯誤或重複'; END IF;
  IF v ? 'options' THEN
   IF jsonb_array_length(v->'options') > 30 THEN RAISE EXCEPTION '選項最多 30 個'; END IF;
   FOR o IN SELECT value FROM jsonb_array_elements(v->'options') LOOP
    IF jsonb_typeof(o) <> 'string' OR length(o#>>'{}') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION '選項格式錯誤'; END IF;
   END LOOP;
  END IF;
  IF v->>'type' IN ('select','radio') AND jsonb_array_length(coalesce(v->'options','[]')) < 1 THEN RAISE EXCEPTION '選單變數至少要有一個選項'; END IF;
  names := array_append(names,v->>'name');
 END LOOP;
 SELECT coalesce(array_agg(DISTINCT m[1]),ARRAY[]::text[]) INTO placeholders
 FROM regexp_matches((item->>'body') || E'\n' || coalesce(en,''),'\{\{([^{}]+)\}\}','g') AS m;
 IF NOT (names @> placeholders AND names <@ placeholders) THEN RAISE EXCEPTION '本文與變數不一致'; END IF;
 SELECT id INTO cat FROM public.category WHERE name=item->>'category' AND archived_at IS NULL ORDER BY sort_order, id LIMIT 1;
 IF cat IS NULL AND editing_id IS NULL THEN SELECT id INTO cat FROM public.category WHERE slug='other'; END IF;
 IF cat IS NULL THEN RAISE EXCEPTION '分類不存在，請重新整理後再試'; END IF;
 h := encode(sha256(convert_to(lower(regexp_replace(normalize(item->>'body',NFKC),'[[:space:]]','','g')),'UTF8')),'hex');
 IF editing_id IS NULL THEN
  INSERT INTO public.prompt(title,body,body_en,summary,use_case,model_hint,variables,tags,category_id,lang,
    visibility,author_id,source,source_body,embedding,embedding_model,normalized_hash,simhash,search_text,version_note,summary_auto)
  VALUES(btrim(item->>'title'),item->>'body',en,item->>'summary',btrim(item->>'title'),
    ARRAY(SELECT jsonb_array_elements_text(item->'model_hint')),item->'variables',
    ARRAY(SELECT jsonb_array_elements_text(item->'tags')),cat,'zh-Hant','public',
    '00000000-0000-4000-8000-000000000001',left(coalesce(item->>'source','雲端匯入'),2000),item->>'body',
    NULL,'not-generated',h,'0000000000000000','',coalesce(item->>'version_note',''),auto)
  ON CONFLICT(author_id,normalized_hash) DO NOTHING RETURNING * INTO p;
  IF p.id IS NULL THEN
   SELECT * INTO p FROM public.prompt WHERE author_id='00000000-0000-4000-8000-000000000001' AND normalized_hash=h;
   IF p.deleted_at IS NOT NULL THEN RAISE EXCEPTION '相同內容已刪除；請先修改內容再加入（本機資料會保留）'; END IF;
  END IF;
 ELSE
  UPDATE public.prompt SET title=btrim(item->>'title'),body=item->>'body',body_en=en,summary=item->>'summary',
    use_case=btrim(item->>'title'),model_hint=ARRAY(SELECT jsonb_array_elements_text(item->'model_hint')),
    variables=item->'variables',tags=ARRAY(SELECT jsonb_array_elements_text(item->'tags')),category_id=cat,
    source_body=item->>'body',normalized_hash=h,embedding=NULL,embedding_model='not-generated',
    simhash='0000000000000000',version_note=coalesce(item->>'version_note',version_note),summary_auto=auto,updated_at=clock_timestamp()
  WHERE id=editing_id AND author_id='00000000-0000-4000-8000-000000000001'
    AND deleted_at IS NULL AND updated_at=expected_version RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '資料已被修改或刪除，請重新載入後再試'; END IF;
 END IF;
 RETURN p;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_prompt_save(jsonb,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
INSERT INTO public.schema_migration(version) VALUES(6) ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
