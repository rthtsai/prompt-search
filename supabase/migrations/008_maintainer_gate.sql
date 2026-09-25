-- ============================================================================
-- 008：維護者閘門
--
-- 在此之前，prompt_library 的 EXECUTE 權限給了 anon，而 delete / delete_many /
-- merge 完全沒有呼叫者檢查；publishable key 就印在前端 bundle 裡，任何人用一行
-- curl 就能把整個共用辭典刪光。前端隱藏按鈕擋不住這件事，所以閘門放在資料庫。
--
-- 原則：會讓現有內容「消失或被覆蓋」的操作需要維護者 token；只會「新增」的
-- 操作維持開放（匯入、另存一份、存成新版本、使用紀錄、改分類）。
--
-- 作法是把原本的實作改名藏起來，外面包一層檢查。這樣不必重抄三百行函式，
-- 也不會動到既有邏輯。⚠️ 之後若重跑 003 或 005，prompt_library 會被覆蓋成
-- 沒有閘門的版本，必須再跑一次這個檔案。
--
-- token 本身不在版控裡：只存 sha256，由維護者另外用一行 SQL 寫入 app_secret。
-- 沒有寫入那一行之前，所有破壞性操作對所有人都是關閉的（fail closed）。
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.app_secret (
  name text PRIMARY KEY,
  hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_secret ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_secret FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.shared_is_maintainer(token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_secret s
    WHERE s.name = 'maintainer'
      AND length(coalesce(token,'')) >= 16
      AND s.hash = encode(sha256(convert_to(token,'UTF8')),'hex'));
$$;
REVOKE ALL ON FUNCTION public.shared_is_maintainer(text) FROM PUBLIC, anon, authenticated;

-- 把既有實作改名；只做一次
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname='public' AND p.proname='prompt_library_impl') THEN
    EXECUTE 'ALTER FUNCTION public.prompt_library(jsonb) RENAME TO prompt_library_impl';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.prompt_library_impl(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.prompt_library(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE op text := request->>'op'; token text := request->>'maintainer'; n integer;
 ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 -- 會讓現有內容消失或被覆蓋的操作
 IF op IN ('delete','delete_many','merge','categories_save','example_remove','edit','restore') THEN
  IF NOT public.shared_is_maintainer(token)
   THEN RAISE EXCEPTION '這個操作保留給維護者。你仍然可以新增、另存一份與複製。'; END IF;
 END IF;

 -- 誤刪救回：刪除是軟刪，所以復原只是把 deleted_at 清掉。
 IF op='restore' THEN
  UPDATE public.prompt SET deleted_at=NULL, updated_at=clock_timestamp()
   WHERE id=(request->>'id')::uuid AND author_id=ws AND deleted_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=0 THEN RAISE EXCEPTION '已經來不及復原了，請重新載入看看'; END IF;
  RETURN jsonb_build_object('restored',true,'id',(request->>'id')::uuid);
 END IF;
 IF op='restore_many' THEN
  IF NOT public.shared_is_maintainer(token)
   THEN RAISE EXCEPTION '這個操作保留給維護者。'; END IF;
  UPDATE public.prompt SET deleted_at=NULL, updated_at=clock_timestamp()
   WHERE id = ANY(public.shared_uuid_list(request->'ids')) AND author_id=ws AND deleted_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('restored',n);
 END IF;

 -- token 不往下傳，免得寫進任何紀錄
 RETURN public.prompt_library_impl(request - 'maintainer');
END;
$$;
REVOKE ALL ON FUNCTION public.prompt_library(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prompt_library(jsonb) TO anon, authenticated;

COMMIT;
