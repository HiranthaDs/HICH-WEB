begin;
alter table public.clients add column deleted_at timestamptz;
alter table public.invoices add column deleted_at timestamptz;
alter table public.agreements add column deleted_at timestamptz;
alter table public.payments add column date_confirmed boolean not null default true;

-- A signed document may be removed from the workspace without changing its evidence.
create or replace function public.protect_signed_agreement()
returns trigger language plpgsql set search_path = public as $$
begin
    if tg_op = 'DELETE' and old.status = 'signed' then
        raise exception 'Signed agreements are immutable' using errcode = '55000';
    end if;
    if tg_op = 'UPDATE' and old.status = 'signed' and new is distinct from old then
        if old.deleted_at is null and new.deleted_at is not null
            and (to_jsonb(new) - array['deleted_at', 'updated_at']) = (to_jsonb(old) - array['deleted_at', 'updated_at']) then
            return new;
        end if;
        raise exception 'Signed agreements are immutable' using errcode = '55000';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;

-- Editing a receipt date through either the receipt or phase editor confirms it.
create function public.confirm_payment_date() returns trigger
language plpgsql set search_path = public as $$
begin
    if new.paid_at is distinct from old.paid_at then new.date_confirmed := true; end if;
    return new;
end;
$$;
create trigger payments_confirm_date before update on public.payments
for each row execute function public.confirm_payment_date();
commit;
