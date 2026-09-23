-- Apply in the Supabase SQL editor after 004_examples.sql (needs the storage schema, so it is a separate file).
-- Bucket for example images. Public read; visitors may upload but never overwrite or delete,
-- so an image can only be detached from a prompt, not replaced by someone else.
INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('prompt-examples','prompt-examples',true,3145728,'{image/jpeg,image/png,image/webp}')
ON CONFLICT (id) DO UPDATE SET public=true, file_size_limit=3145728,
  allowed_mime_types='{image/jpeg,image/png,image/webp}';

DROP POLICY IF EXISTS prompt_examples_read ON storage.objects;
CREATE POLICY prompt_examples_read ON storage.objects FOR SELECT
  TO anon, authenticated USING (bucket_id='prompt-examples');

-- <prompt id>/<random uuid>.<ext>: the path is unpredictable, so no one can guess and clobber a key.
DROP POLICY IF EXISTS prompt_examples_insert ON storage.objects;
CREATE POLICY prompt_examples_insert ON storage.objects FOR INSERT
  TO anon, authenticated WITH CHECK (bucket_id='prompt-examples'
    AND name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$');
