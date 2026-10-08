begin;

alter table public.invoices
    add column if not exists payment_instructions text check (payment_instructions is null or length(payment_instructions) <= 5000),
    add column if not exists customer_note text check (customer_note is null or length(customer_note) <= 5000),
    add column if not exists revision integer not null default 0,
    add column if not exists share_active boolean not null default false,
    add column if not exists share_nonce uuid,
    add column if not exists share_token_hash char(64),
    add column if not exists share_expires_at timestamptz,
    add column if not exists shared_at timestamptz;

create unique index if not exists invoices_share_token_hash_idx
    on public.invoices(share_token_hash) where share_token_hash is not null;

create table if not exists public.invoice_versions (
    id bigint generated always as identity primary key,
    invoice_id uuid not null references public.invoices(id) on delete cascade,
    version integer not null check (version > 0),
    snapshot jsonb not null,
    transaction_id bigint not null,
    created_at timestamptz not null default now(),
    unique (invoice_id, version),
    unique (invoice_id, transaction_id)
);
alter table public.invoice_versions enable row level security;
create policy invoice_versions_admin_read on public.invoice_versions
    for select to authenticated using (public.is_admin());
grant select on public.invoice_versions to authenticated;
grant all on public.invoice_versions to service_role;
grant usage, select on sequence public.invoice_versions_id_seq to service_role;

-- One revision per database transaction, including all milestone/payment writes.
-- The parent row lock serializes concurrent edits and revision allocation.
create or replace function public.refresh_invoice_version(p_invoice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
    invoice_record public.invoices;
    next_version integer;
    snapshot_record jsonb;
begin
    select * into invoice_record from public.invoices where id = p_invoice_id for update;
    if not found then return; end if;
    select version into next_version from public.invoice_versions
        where invoice_id = p_invoice_id and transaction_id = txid_current();
    if next_version is null then
        select coalesce(max(version), 0) + 1 into next_version
            from public.invoice_versions where invoice_id = p_invoice_id;
    end if;
    update public.invoices set revision = next_version where id = p_invoice_id and revision <> next_version;
    snapshot_record := (to_jsonb(invoice_record) - array[
        'share_nonce', 'share_token_hash', 'share_active', 'share_expires_at', 'shared_at'
    ]) || jsonb_build_object(
        'revision', next_version,
        'client', (select jsonb_build_object('name', name, 'company', company, 'phone', phone, 'email', email)
                   from public.clients where id = invoice_record.client_id),
        'milestones', coalesce((select jsonb_agg(to_jsonb(m) order by position, created_at)
                               from public.invoice_milestones m where invoice_id = p_invoice_id), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(to_jsonb(p) order by paid_at, created_at)
                             from public.payments p where invoice_id = p_invoice_id), '[]'::jsonb)
    );
    insert into public.invoice_versions(invoice_id, version, snapshot, transaction_id)
        values (p_invoice_id, next_version, snapshot_record, txid_current())
        on conflict (invoice_id, transaction_id) do update set snapshot = excluded.snapshot;
end;
$$;

create or replace function public.capture_invoice_version()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    ignored text[] := array['revision', 'updated_at', 'share_nonce', 'share_token_hash', 'share_active', 'share_expires_at', 'shared_at'];
begin
    if tg_table_name = 'invoices' then
        if tg_op = 'UPDATE' and (to_jsonb(old) - ignored) is not distinct from (to_jsonb(new) - ignored) then
            return new;
        end if;
        perform public.refresh_invoice_version(new.id);
    else
        if tg_op = 'UPDATE' and (to_jsonb(old) - 'updated_at') is not distinct from (to_jsonb(new) - 'updated_at') then
            return new;
        end if;
        perform public.refresh_invoice_version(coalesce(new.invoice_id, old.invoice_id));
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;

create trigger capture_invoice_version_after_write after insert or update on public.invoices
    for each row execute function public.capture_invoice_version();
create trigger zz_capture_milestone_invoice_version after insert or update or delete on public.invoice_milestones
    for each row execute function public.capture_invoice_version();
create trigger zz_capture_payment_invoice_version after insert or update or delete on public.payments
    for each row execute function public.capture_invoice_version();

create or replace function public.guard_invoice_child_write()
returns trigger language plpgsql set search_path = public as $$
declare
    parent public.invoices;
begin
    if tg_op = 'UPDATE' and new.invoice_id <> old.invoice_id then
        raise exception 'invoice_validation: a financial record cannot move between invoices';
    end if;
    select * into parent from public.invoices where id = coalesce(new.invoice_id, old.invoice_id) for update;
    if parent.status = 'void' then raise exception 'invoice_void'; end if;
    if tg_table_name = 'payments' and tg_op <> 'DELETE' then
        if new.currency <> parent.currency then
            raise exception 'invoice_validation: payment currency must match the invoice currency';
        end if;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;
create trigger guard_invoice_milestone_write before insert or update or delete on public.invoice_milestones
    for each row execute function public.guard_invoice_child_write();
create trigger guard_invoice_payment_write before insert or update or delete on public.payments
    for each row execute function public.guard_invoice_child_write();

create or replace function public.save_invoice_document(
    p_invoice_id uuid,
    p_fields jsonb,
    p_phases jsonb default null,
    p_milestones jsonb default null,
    p_actor_id uuid default null,
    p_expected_revision integer default null
) returns setof public.invoices language plpgsql security definer set search_path = public as $$
declare
    current_record public.invoices;
    target public.invoices;
    target_id uuid;
    phase jsonb;
    phase_id uuid;
    phase_paid boolean;
    phase_amount numeric(14,2);
    old_amount numeric(14,2);
    paid_amount numeric(14,2);
    total_amount numeric(14,2);
    retained uuid[] := array[]::uuid[];
    removed_id uuid;
begin
    if p_phases is not null and p_milestones is not null then
        raise exception 'invoice_validation: use payment phases or milestones, not both';
    end if;
    if p_invoice_id is null then
        target_id := gen_random_uuid();
        target := jsonb_populate_record(null::public.invoices,
            jsonb_build_object('currency', 'LKR', 'issue_date', current_date, 'status', 'draft') || p_fields);
        insert into public.invoices(id, invoice_number, client_id, agreement_id, project_title, currency,
            project_value, renewal_amount, renewal_currency, renewal_due_date, issue_date, due_date,
            payment_method, notes, payment_instructions, customer_note, status, created_by)
        values(target_id, target.invoice_number, target.client_id, target.agreement_id, target.project_title,
            target.currency, target.project_value, target.renewal_amount, target.renewal_currency,
            target.renewal_due_date, target.issue_date, target.due_date, target.payment_method,
            target.notes, target.payment_instructions, target.customer_note, target.status, p_actor_id);
    else
        target_id := p_invoice_id;
        select * into current_record from public.invoices where id = target_id for update;
        if not found then raise exception 'invoice_not_found'; end if;
        if current_record.status = 'void' then raise exception 'invoice_void'; end if;
        if p_expected_revision is not null and current_record.revision <> p_expected_revision then
            raise exception 'invoice_revision_conflict';
        end if;
        target := jsonb_populate_record(current_record, p_fields);
        if target.currency <> current_record.currency and exists(select 1 from public.payments where invoice_id = target_id) then
            raise exception 'invoice_validation: currency cannot change after payments are recorded';
        end if;
        update public.invoices set invoice_number = target.invoice_number, client_id = target.client_id,
            agreement_id = target.agreement_id, project_title = target.project_title, currency = target.currency,
            project_value = target.project_value, renewal_amount = target.renewal_amount,
            renewal_currency = target.renewal_currency, renewal_due_date = target.renewal_due_date,
            issue_date = target.issue_date, due_date = target.due_date, payment_method = target.payment_method,
            notes = target.notes, payment_instructions = target.payment_instructions,
            customer_note = target.customer_note, status = target.status
        where id = target_id;
        -- Reassigning an invoice must never expose another client's details at an old URL.
        if target.client_id <> current_record.client_id then
            update public.invoices set share_active = false, share_nonce = null, share_token_hash = null
                where id = target_id;
        end if;
    end if;

    if p_phases is not null then
        if jsonb_typeof(p_phases) <> 'array' then raise exception 'invoice_validation: phases must be a list'; end if;
        for phase in select value from jsonb_array_elements(p_phases) loop
            phase_amount := (phase->>'amount')::numeric;
            if phase_amount <= 0 then continue; end if;
            phase_id := nullif(phase->>'id', '')::uuid;
            phase_paid := coalesce((phase->>'is_paid')::boolean, false) or coalesce((phase->>'isPaid')::boolean, false);
            old_amount := null;
            if phase_id is not null then
                select amount into old_amount from public.invoice_milestones where id = phase_id and invoice_id = target_id;
                if not found then raise exception 'invoice_validation: milestone does not belong to this invoice'; end if;
                if phase_id = any(retained) then raise exception 'invoice_validation: repeated milestone'; end if;
                update public.invoice_milestones set title = phase->>'name', amount = phase_amount,
                    position = cardinality(retained) where id = phase_id;
            else
                insert into public.invoice_milestones(invoice_id, title, amount, position)
                    values(target_id, phase->>'name', phase_amount, cardinality(retained)) returning id into phase_id;
            end if;
            retained := array_append(retained, phase_id);
            select coalesce(sum(amount), 0) into paid_amount from public.payments where milestone_id = phase_id;
            if phase_paid and paid_amount < phase_amount then
                insert into public.payments(invoice_id, milestone_id, amount, currency, method, reference, paid_at, created_by)
                    values(target_id, phase_id, phase_amount - paid_amount, target.currency, target.payment_method,
                           'Invoice phase payment', coalesce((phase->>'paid_at')::timestamptz, now()), p_actor_id);
            elsif not phase_paid and paid_amount > 0 and paid_amount >= coalesce(old_amount, phase_amount) then
                if exists(select 1 from public.payments where milestone_id = phase_id and reference is distinct from 'Invoice phase payment') then
                    raise exception 'invoice_validation: edit recorded payments directly before marking a paid phase unpaid';
                end if;
                delete from public.payments where milestone_id = phase_id;
            end if;
        end loop;
        for removed_id in select id from public.invoice_milestones where invoice_id = target_id and not (id = any(retained)) loop
            if exists(select 1 from public.payments where milestone_id = removed_id) then
                raise exception 'invoice_validation: a milestone with recorded payments cannot be removed';
            end if;
            delete from public.invoice_milestones where id = removed_id;
        end loop;
    elsif p_milestones is not null then
        if exists(select 1 from public.payments where invoice_id = target_id and milestone_id is not null) then
            raise exception 'invoice_validation: update existing paid milestones individually';
        end if;
        delete from public.invoice_milestones where invoice_id = target_id;
        insert into public.invoice_milestones(invoice_id, title, description, amount, due_date, status, position)
            select target_id, item.title, item.description, item.amount, item.due_date,
                   coalesce(item.status, 'pending'), coalesce(item.position, 0)
            from jsonb_populate_recordset(null::public.invoice_milestones, p_milestones) item;
    end if;

    select sum(amount) into total_amount from public.invoice_milestones where invoice_id = target_id;
    if total_amount is not null and total_amount <> target.project_value then
        raise exception 'invoice_validation: payment phases must add up to the project value';
    end if;
    select coalesce(sum(amount), 0) into paid_amount from public.payments where invoice_id = target_id;
    update public.invoices set status = case
        when status = 'void' then 'void'::public.invoice_status
        when paid_amount >= project_value then 'paid'::public.invoice_status
        when paid_amount > 0 then 'partial'::public.invoice_status
        when status in ('partial', 'paid') then 'sent'::public.invoice_status
        else status end where id = target_id;
    update public.invoice_milestones m set status = case
        when m.status = 'waived' then m.status
        when coalesce((select sum(p.amount) from public.payments p where p.milestone_id = m.id), 0) >= m.amount then 'paid'::public.milestone_status
        when m.status = 'paid' then 'invoiced'::public.milestone_status
        else m.status end where m.invoice_id = target_id;
    return query select * from public.invoices where id = target_id;
end;
$$;

create or replace function public.publish_invoice_link(
    p_invoice_id uuid, p_nonce uuid, p_token_hash text, p_rotate boolean default false,
    p_expires_at timestamptz default null, p_set_expiry boolean default false
) returns setof public.invoices language plpgsql security definer set search_path = public as $$
declare
    invoice_record public.invoices;
    replace_link boolean;
begin
    select * into invoice_record from public.invoices where id = p_invoice_id for update;
    if not found then raise exception 'invoice_not_found'; end if;
    if invoice_record.status = 'void' then raise exception 'invoice_void'; end if;
    if p_expires_at is not null and p_expires_at <= now() then
        raise exception 'invoice_validation: link expiry must be in the future';
    end if;
    if p_token_hash !~ '^[a-f0-9]{64}$' then raise exception 'invoice_validation: invalid link hash'; end if;
    replace_link := p_rotate or not invoice_record.share_active or invoice_record.share_nonce is null;
    update public.invoices set
        share_nonce = case when replace_link then p_nonce else share_nonce end,
        share_token_hash = case when replace_link then p_token_hash else share_token_hash end,
        share_expires_at = case when p_set_expiry then p_expires_at
            when replace_link then null else share_expires_at end,
        share_active = true,
        shared_at = coalesce(shared_at, now()),
        status = case when status = 'draft' then 'sent'::public.invoice_status else status end
    where id = p_invoice_id;
    return query select * from public.invoices where id = p_invoice_id;
end;
$$;

-- Functions that bypass RLS are callable only through the authenticated backend.
revoke all on function public.refresh_invoice_version(uuid) from public, anon, authenticated;
revoke all on function public.capture_invoice_version() from public, anon, authenticated;
revoke all on function public.save_invoice_document(uuid, jsonb, jsonb, jsonb, uuid, integer) from public, anon, authenticated;
revoke all on function public.publish_invoice_link(uuid, uuid, text, boolean, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.save_invoice_document(uuid, jsonb, jsonb, jsonb, uuid, integer) to service_role;
grant execute on function public.publish_invoice_link(uuid, uuid, text, boolean, timestamptz, boolean) to service_role;

-- Establish history for invoices created before this migration.
do $$ declare invoice_id uuid; begin
    for invoice_id in select id from public.invoices loop
        perform public.refresh_invoice_version(invoice_id);
    end loop;
end $$;

commit;
