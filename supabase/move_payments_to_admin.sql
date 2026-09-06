-- Existing Supabase projects: run once in SQL Editor.
-- Payments remain visible to administrators only and can only be inserted by them.
begin;

drop policy if exists "wallet_teacher_create_payment" on public.wallet_ledger;

commit;
