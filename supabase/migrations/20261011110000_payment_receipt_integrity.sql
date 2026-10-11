-- Make receipt creation retry-safe, keep receipt ownership unambiguous, and
-- advance a completed annual renewal exactly once.
begin;

alter table public.payments
    add column if not exists idempotency_key uuid,
    add column if not exists receipt_number text;

create sequence if not exists public.payment_receipt_number_seq;

-- Metadata backfill must not revalidate old/void receipts or rewrite their
-- financial status and revision history. DDL locks keep other writers out;
-- these triggers are restored in the same transaction before normal writes.
alter table public.payments disable trigger guard_invoice_payment_write;
alter table public.payments disable trigger recalculate_invoice_after_payment;
alter table public.payments disable trigger zz_capture_payment_invoice_version;

-- Existing receipts predate request idempotency. Their immutable payment id is
-- a safe one-time key, while human-facing receipt numbers use the same global
-- sequence as all future receipts.
update public.payments
set idempotency_key = coalesce(idempotency_key, id),
    receipt_number = coalesce(
        receipt_number,
        'RCT-' || lpad(nextval('public.payment_receipt_number_seq')::text, 8, '0')
    )
where idempotency_key is null or receipt_number is null;

alter table public.payments enable trigger guard_invoice_payment_write;
alter table public.payments enable trigger recalculate_invoice_after_payment;
alter table public.payments enable trigger zz_capture_payment_invoice_version;

alter table public.payments
    alter column idempotency_key set not null,
    alter column receipt_number set not null;

create unique index if not exists payments_invoice_idempotency_unique
    on public.payments(invoice_id, idempotency_key);
create unique index if not exists payments_receipt_number_unique
    on public.payments(receipt_number);

alter table public.payments
    drop constraint if exists payments_receipt_number_format;
alter table public.payments
    add constraint payments_receipt_number_format
    check (receipt_number ~ '^RCT-[0-9]{8,}$');

create or replace function public.ensure_payment_identity()
returns trigger language plpgsql set search_path = public as $$
begin
    if tg_op = 'UPDATE' then
        if new.idempotency_key is distinct from old.idempotency_key then
            raise exception 'invoice_validation: a payment idempotency key cannot change';
        end if;
        if new.receipt_number is distinct from old.receipt_number then
            raise exception 'invoice_validation: a receipt number cannot change';
        end if;
        return new;
    end if;
    new.idempotency_key := coalesce(new.idempotency_key, gen_random_uuid());
    new.receipt_number := coalesce(
        nullif(new.receipt_number, ''),
        'RCT-' || lpad(nextval('public.payment_receipt_number_seq')::text, 8, '0')
    );
    return new;
end;
$$;
drop trigger if exists payments_ensure_identity on public.payments;
create trigger payments_ensure_identity
before insert or update on public.payments
for each row execute function public.ensure_payment_identity();

-- Enforce ownership declaratively as well as in the validation trigger. A
-- milestone with receipts cannot be deleted and a receipt cannot point to a
-- milestone belonging to another invoice.
alter table public.payments
    drop constraint if exists payments_milestone_invoice_fkey;
alter table public.invoice_milestones
    drop constraint if exists invoice_milestones_id_invoice_id_key;
alter table public.invoice_milestones
    add constraint invoice_milestones_id_invoice_id_key unique (id, invoice_id);
alter table public.payments
    drop constraint if exists payments_milestone_id_fkey;
alter table public.payments
    drop constraint if exists payments_milestone_invoice_fkey;
alter table public.payments
    add constraint payments_milestone_invoice_fkey
    foreign key (milestone_id, invoice_id)
    references public.invoice_milestones(id, invoice_id)
    on delete restrict;

create or replace function public.validate_payment_milestone()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.milestone_id is null then
        if exists (
            select 1 from public.invoice_milestones where invoice_id = new.invoice_id
        ) then
            raise exception 'invoice_validation: choose a payment milestone for this receipt';
        end if;
    elsif not exists (
        select 1 from public.invoice_milestones
        where id = new.milestone_id and invoice_id = new.invoice_id
    ) then
        raise exception 'invoice_validation: milestone does not belong to this invoice';
    end if;
    return new;
end;
$$;

-- A receipt is part of one client's financial history. Moving its invoice to
-- another client would silently move the receipt between client profiles.
create or replace function public.protect_invoice_receipt_owner()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.client_id is distinct from old.client_id
       and exists (select 1 from public.payments where invoice_id = old.id) then
        raise exception 'invoice_validation: an invoice with recorded payments cannot move to another client';
    end if;
    return new;
end;
$$;
drop trigger if exists protect_invoice_receipt_owner_before_update on public.invoices;
create trigger protect_invoice_receipt_owner_before_update
before update of client_id on public.invoices
for each row execute function public.protect_invoice_receipt_owner();

-- Recalculate both milestones when a receipt is reassigned. When a dedicated
-- renewal bill first becomes fully paid, advance only the matching source
-- cycle. Later corrections/deletions never roll the source date backwards.
create or replace function public.recalculate_invoice_payment_status()
returns trigger language plpgsql set search_path = public as $$
declare
    target_invoice uuid;
    old_milestone uuid;
    new_milestone uuid;
    paid_total numeric(14,2);
    invoice_total numeric(14,2);
    invoice_kind_value text;
    renewal_source uuid;
    renewal_period date;
begin
    if tg_op = 'INSERT' then
        target_invoice := new.invoice_id;
        new_milestone := new.milestone_id;
    elsif tg_op = 'UPDATE' then
        target_invoice := new.invoice_id;
        old_milestone := old.milestone_id;
        new_milestone := new.milestone_id;
    else
        target_invoice := old.invoice_id;
        old_milestone := old.milestone_id;
    end if;

    select project_value, invoice_kind, renewal_source_invoice_id, renewal_period_date
    into invoice_total, invoice_kind_value, renewal_source, renewal_period
    from public.invoices where id = target_invoice for update;
    select coalesce(sum(amount), 0) into paid_total
    from public.payments where invoice_id = target_invoice;

    update public.invoices
    set status = case
        when status = 'void' then 'void'::public.invoice_status
        when paid_total >= invoice_total then 'paid'::public.invoice_status
        when paid_total > 0 then 'partial'::public.invoice_status
        when status in ('paid', 'partial') then 'sent'::public.invoice_status
        else status
    end
    where id = target_invoice;

    if old_milestone is not null then
        update public.invoice_milestones m
        set status = case
            when m.status = 'waived' then m.status
            when coalesce((select sum(p.amount) from public.payments p where p.milestone_id = m.id), 0) >= m.amount
                then 'paid'::public.milestone_status
            when m.status = 'paid' then 'invoiced'::public.milestone_status
            else m.status
        end
        where m.id = old_milestone;
    end if;
    if new_milestone is not null and new_milestone is distinct from old_milestone then
        update public.invoice_milestones m
        set status = case
            when m.status = 'waived' then m.status
            when coalesce((select sum(p.amount) from public.payments p where p.milestone_id = m.id), 0) >= m.amount
                then 'paid'::public.milestone_status
            when m.status = 'paid' then 'invoiced'::public.milestone_status
            else m.status
        end
        where m.id = new_milestone;
    end if;

    if invoice_kind_value = 'renewal'
       and renewal_source is not null
       and renewal_period is not null
       and paid_total >= invoice_total then
        update public.invoices
        set renewal_due_date = (renewal_period + interval '1 year')::date
        where id = renewal_source
          and invoice_kind = 'project'
          and renewal_due_date = renewal_period;
    end if;

    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;

-- Retry-safe receipt creation. The parent row lock serializes balance checks;
-- an identical key returns the original receipt, while a conflicting reuse is
-- rejected instead of mutating or duplicating financial data.
create or replace function public.record_invoice_payment(
    p_invoice_id uuid,
    p_fields jsonb,
    p_actor_id uuid default null
) returns setof public.payments language plpgsql security definer set search_path = public as $$
declare
    parent public.invoices;
    existing public.payments;
    payment_key uuid;
    requested_milestone uuid;
    requested_amount numeric(14,2);
    requested_currency text;
    requested_method text;
    requested_reference text;
    requested_paid_at timestamptz;
    requested_notes text;
begin
    select * into parent from public.invoices where id = p_invoice_id for update;
    if not found or parent.deleted_at is not null then raise exception 'invoice_not_found'; end if;
    if parent.status = 'void' then raise exception 'invoice_void'; end if;

    payment_key := nullif(p_fields->>'idempotency_key', '')::uuid;
    if payment_key is null then
        raise exception 'invoice_validation: payment idempotency key is required';
    end if;
    requested_milestone := nullif(p_fields->>'milestone_id', '')::uuid;
    requested_amount := (p_fields->>'amount')::numeric;
    requested_currency := p_fields->>'currency';
    requested_method := nullif(p_fields->>'method', '');
    requested_reference := nullif(p_fields->>'reference', '');
    requested_paid_at := (p_fields->>'paid_at')::timestamptz;
    requested_notes := nullif(p_fields->>'notes', '');

    select * into existing from public.payments
    where invoice_id = p_invoice_id and idempotency_key = payment_key;
    if found then
        if existing.milestone_id is distinct from requested_milestone
           or existing.amount is distinct from requested_amount
           or existing.currency is distinct from requested_currency
           or existing.method is distinct from requested_method
           or existing.reference is distinct from requested_reference
           or existing.paid_at is distinct from requested_paid_at
           or existing.notes is distinct from requested_notes then
            raise exception 'invoice_validation: this payment retry key was already used with different details';
        end if;
        return next existing;
        return;
    end if;

    return query
    insert into public.payments(
        invoice_id, milestone_id, amount, currency, method, reference,
        paid_at, notes, created_by, idempotency_key
    ) values (
        p_invoice_id, requested_milestone, requested_amount, requested_currency,
        requested_method, requested_reference, requested_paid_at,
        requested_notes, p_actor_id, payment_key
    ) returning *;
end;
$$;

revoke all on function public.record_invoice_payment(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_invoice_payment(uuid, jsonb, uuid) to service_role;
grant usage, select on sequence public.payment_receipt_number_seq to service_role;

-- Bring already-paid cycles forward during deployment without overwriting a
-- date an operator has already changed to a later or custom cycle.
update public.invoices source
set renewal_due_date = (bill.renewal_period_date + interval '1 year')::date
from public.invoices bill
where bill.invoice_kind = 'renewal'
  and bill.status <> 'void'
  and bill.deleted_at is null
  and bill.renewal_source_invoice_id = source.id
  and source.invoice_kind = 'project'
  and source.renewal_due_date = bill.renewal_period_date
  and coalesce((select sum(p.amount) from public.payments p where p.invoice_id = bill.id), 0) >= bill.project_value;

commit;
