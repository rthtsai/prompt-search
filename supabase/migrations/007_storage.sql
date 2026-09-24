-- 在 007_video_examples.sql 之後於 SQL 編輯器執行（需要 storage schema）。
-- 影片加入白名單，上限拉到 25 MB；其餘格式維持不變。
INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('prompt-examples','prompt-examples',true,26214400,
  '{image/jpeg,image/png,image/webp,video/mp4,video/webm,application/pdf,text/plain,text/markdown,text/csv,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation}')
ON CONFLICT (id) DO UPDATE SET public=true, file_size_limit=26214400,
  allowed_mime_types=excluded.allowed_mime_types;

DROP POLICY IF EXISTS prompt_examples_insert ON storage.objects;
CREATE POLICY prompt_examples_insert ON storage.objects FOR INSERT
  TO anon, authenticated WITH CHECK (bucket_id='prompt-examples'
    AND name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|jpeg|png|webp|mp4|webm|pdf|docx|xlsx|pptx|txt|md|csv|json)$');
