begin;

-- The client shows the same limit, but this protects the school quota from bypasses.
create or replace function public.register_file_attachment(
  p_school_id uuid,
  p_storage_path text,
  p_original_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_lesson_id uuid default null,
  p_homework_id uuid default null,
  p_submission_id uuid default null,
  p_homework_student_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_allowed boolean := false;
  v_target_school_id uuid;
  v_stored_size bigint;
  v_school_file_bytes bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if num_nonnulls(p_lesson_id, p_homework_id, p_submission_id, p_homework_student_id) <> 1 then raise exception 'Exactly one file target is required'; end if;
  if (storage.foldername(p_storage_path))[1] <> auth.uid()::text then raise exception 'Invalid storage path'; end if;
  if p_byte_size is null or p_byte_size <= 0 then raise exception 'File size must be positive'; end if;

  select nullif(metadata ->> 'size', '')::bigint into v_stored_size
  from storage.objects
  where bucket_id = 'portal-files' and name = p_storage_path;
  if v_stored_size is null then raise exception 'Stored file was not found'; end if;
  if v_stored_size <> p_byte_size then raise exception 'Invalid file size metadata'; end if;
  if coalesce(p_mime_type, '') not like 'audio/%' and coalesce(p_mime_type, '') not like 'video/%' and p_byte_size > 3145728 then
    raise exception 'Documents and images must not exceed 3 MB';
  end if;

  if p_lesson_id is not null then
    select school_id into v_target_school_id from public.lessons where id = p_lesson_id;
    v_allowed := public.is_lesson_teacher(p_lesson_id) or public.is_lesson_student(p_lesson_id);
  elsif p_homework_id is not null then
    select school_id into v_target_school_id from public.homework where id = p_homework_id;
    v_allowed := exists (select 1 from public.homework h where h.id = p_homework_id and (h.teacher_id = auth.uid() or (h.status = 'published' and exists (select 1 from public.homework_students hs where hs.homework_id = h.id and hs.student_id = auth.uid()))));
  elsif p_submission_id is not null then
    select h.school_id into v_target_school_id from public.homework_submissions s join public.homework_students hs on hs.id = s.homework_student_id join public.homework h on h.id = hs.homework_id where s.id = p_submission_id;
    v_allowed := exists (select 1 from public.homework_submissions s join public.homework_students hs on hs.id = s.homework_student_id join public.homework h on h.id = hs.homework_id where s.id = p_submission_id and (s.student_id = auth.uid() or h.teacher_id = auth.uid()));
  elsif p_homework_student_id is not null then
    select h.school_id into v_target_school_id from public.homework_students hs join public.homework h on h.id = hs.homework_id where hs.id = p_homework_student_id;
    v_allowed := exists (select 1 from public.homework_students hs join public.homework h on h.id = hs.homework_id where hs.id = p_homework_student_id and (hs.student_id = auth.uid() or h.teacher_id = auth.uid()));
  end if;
  if not v_allowed then raise exception 'Access denied'; end if;
  if v_target_school_id is distinct from p_school_id then raise exception 'Invalid school for attachment'; end if;

  select coalesce(sum(byte_size), 0) into v_school_file_bytes
  from public.file_attachments
  where school_id = p_school_id;
  if v_school_file_bytes + p_byte_size > 838860800 then
    raise exception 'School file storage limit of 800 MB has been reached';
  end if;

  insert into public.file_attachments (school_id, uploaded_by, lesson_id, homework_id, submission_id, homework_student_id, storage_path, original_name, mime_type, byte_size)
  values (p_school_id, auth.uid(), p_lesson_id, p_homework_id, p_submission_id, p_homework_student_id, p_storage_path, p_original_name, p_mime_type, p_byte_size)
  returning id into v_id;
  return v_id;
end;
$$;

commit;
