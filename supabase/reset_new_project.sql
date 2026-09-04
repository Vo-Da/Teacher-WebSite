-- USE ONLY FOR A NEW, EMPTY TEACHER PORTAL SUPABASE PROJECT.
-- This removes incomplete Teacher Portal setup objects before running
-- production_schema.sql again. Do not run it after adding real users or data.

drop policy if exists "portal_files_read_related" on storage.objects;
drop policy if exists "portal_files_upload_own_folder" on storage.objects;
drop policy if exists "portal_files_delete_owner" on storage.objects;

-- Storage objects are intentionally not deleted here. Supabase blocks direct
-- deletion from its internal Storage tables; the production schema safely
-- creates or updates the portal-files bucket with an upsert.

drop table if exists
  public.audit_events,
  public.wallet_ledger,
  public.file_attachments,
  public.homework_submissions,
  public.homework_students,
  public.homework,
  public.lesson_students,
  public.lessons,
  public.student_rates,
  public.teacher_students,
  public.subjects,
  public.registration_requests,
  public.school_memberships,
  public.schools,
  public.profiles
cascade;

do $$
declare
  routine record;
begin
  for routine in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'submit_homework', 'create_homework', 'create_lesson',
        'prevent_financial_lesson_delete', 'prevent_direct_lesson_status_change',
        'set_lesson_status', 'approve_registration', 'request_membership',
        'bootstrap_school', 'register_file_attachment', 'can_access_file',
        'is_lesson_student', 'is_lesson_teacher', 'is_school_admin', 'my_role'
      )
  loop
    execute 'drop function if exists ' || routine.signature::text || ' cascade';
  end loop;
end;
$$;

drop type if exists public.ledger_status cascade;
drop type if exists public.ledger_kind cascade;
drop type if exists public.submission_status cascade;
drop type if exists public.homework_status cascade;
drop type if exists public.lesson_status cascade;
drop type if exists public.membership_status cascade;
drop type if exists public.app_role cascade;
