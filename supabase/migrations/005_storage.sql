-- Apply in the Supabase SQL editor after 005_example_files.sql (needs the storage schema).
-- Widens the example bucket: documents as well as images, 10 MB per file.
INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('prompt-examples','prompt-examples',true,10485760,
  '{image/jpeg,image/png,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation}')
ON CONFLICT (id) DO UPDATE SET public=true, file_size_limit=10485760,
  allowed_mime_types=excluded.allowed_mime_types;

DROP POLICY IF EXISTS prompt_examples_read ON storage.objects;
CREATE POLICY prompt_examples_read ON storage.objects FOR SELECT
  TO anon, authenticated USING (bucket_id='prompt-examples');

-- Still <prompt id>/<random uuid>.<ext>, now with the document extensions; uploads only, no overwrite or delete.
DROP POLICY IF EXISTS prompt_examples_insert ON storage.objects;
CREATE POLICY prompt_examples_insert ON storage.objects FOR INSERT
  TO anon, authenticated WITH CHECK (bucket_id='prompt-examples'
    AND name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|jpeg|png|webp|pdf|docx|xlsx|pptx|txt|md|csv|json)$');
