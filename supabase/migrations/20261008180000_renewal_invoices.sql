-- Dedicated renewal bills share the normal receipt ledger but never the development total.
begin;

alter table public.invoices
    add column invoice_kind text not null default 'project' check (invoice_kind in ('project', 'renewal')),
    add column renewal_source_invoice_id uuid references public.invoices(id) on delete restrict,
    add column renewal_period_date date,
    add column renewal_items jsonb not null default '[]'::jsonb,
    add column renewal_late_fee numeric(14,2) not null default 0 check (renewal_late_fee >= 0),
    add column renewal_late_fee_accepted boolean not null default false;

-- One bill per source/expiry cycle, including paid bills; void bills may be replaced.
create unique index renewal_invoice_cycle_unique
    on public.invoices(renewal_source_invoice_id, renewal_period_date)
    where invoice_kind = 'renewal' and status <> 'void';

create or replace function public.validate_renewal_invoice()
returns trigger language plpgsql set search_path = public as $$
declare
    source public.invoices;
    item jsonb;
    base numeric := 0;
begin
    if tg_op = 'UPDATE' then
        if new.invoice_kind is distinct from old.invoice_kind
            or new.renewal_source_invoice_id is distinct from old.renewal_source_invoice_id
            or new.renewal_period_date is distinct from old.renewal_period_date then
            raise exception 'invoice_validation: the invoice type, source and renewal cycle cannot change';
        end if;
        if new.client_id <> old.client_id and exists (
            select 1 from public.invoices where renewal_source_invoice_id = new.id and status <> 'void'
        ) then
            raise exception 'invoice_validation: a project with renewal invoices cannot move to another client';
        end if;
    end if;
    if new.invoice_kind = 'project' then
        if new.renewal_source_invoice_id is not null or new.renewal_period_date is not null
            or new.renewal_items <> '[]'::jsonb or new.renewal_late_fee <> 0 then
            raise exception 'invoice_validation: renewal billing details belong on a renewal invoice';
        end if;
        return new;
    end if;
    if new.status = 'void' then return new; end if;
    select * into source from public.invoices where id = new.renewal_source_invoice_id;
    if not found or source.invoice_kind <> 'project' or source.client_id <> new.client_id
        or new.renewal_period_date is null then
        raise exception 'invoice_validation: renewal source and client must match an existing project invoice';
    end if;
    if tg_op = 'INSERT' and (source.status = 'void' or source.renewal_due_date is distinct from new.renewal_period_date) then
        raise exception 'invoice_validation: reload the source invoice because its renewal date changed';
    end if;
    if coalesce(new.renewal_amount, 0) <> 0 or new.renewal_due_date is not null then
        raise exception 'invoice_validation: keep future renewal settings on the source project invoice';
    end if;
    if jsonb_typeof(new.renewal_items) <> 'array' or jsonb_array_length(new.renewal_items) not between 1 and 20 then
        raise exception 'invoice_validation: enter the domain or hosting service charges';
    end if;
    for item in select value from jsonb_array_elements(new.renewal_items) loop
        if coalesce(item->>'service', '') not in ('domain', 'hosting', 'domain_hosting')
            or length(trim(coalesce(item->>'description', ''))) not between 1 and 240
            or coalesce((item->>'amount')::numeric, 0) <= 0
            or (item->>'amount')::numeric <> round((item->>'amount')::numeric, 2) then
            raise exception 'invoice_validation: each renewal service needs a description and positive two-decimal amount';
        end if;
        base := base + (item->>'amount')::numeric;
    end loop;
    if base + new.renewal_late_fee <> new.project_value then
        raise exception 'invoice_validation: renewal services and surcharge must add up to the invoice total';
    end if;
    if new.renewal_late_fee > 0 and (
        not new.renewal_late_fee_accepted or new.renewal_period_date >= new.issue_date
        or new.renewal_late_fee <> round(base * 0.18, 2)
    ) then
        raise exception 'invoice_validation: the accepted 18%% surcharge applies once to an overdue renewal base';
    end if;
    return new;
end;
$$;
create trigger validate_renewal_invoice before insert or update on public.invoices
    for each row execute function public.validate_renewal_invoice();

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
            jsonb_build_object('currency', 'LKR', 'issue_date', current_date, 'status', 'draft',
                'invoice_kind', 'project', 'renewal_items', '[]'::jsonb, 'renewal_late_fee', 0, 'renewal_late_fee_accepted', false) || p_fields);
        insert into public.invoices(id, invoice_number, client_id, agreement_id, project_title, currency,
            project_value, renewal_amount, renewal_currency, renewal_due_date, issue_date, due_date,
            payment_method, notes, payment_instructions, customer_note, status, created_by, invoice_kind, renewal_source_invoice_id,
            renewal_period_date, renewal_items, renewal_late_fee, renewal_late_fee_accepted)
        values(target_id, target.invoice_number, target.client_id, target.agreement_id, target.project_title,
            target.currency, target.project_value, target.renewal_amount, target.renewal_currency,
            target.renewal_due_date, target.issue_date, target.due_date, target.payment_method,
            target.notes, target.payment_instructions, target.customer_note, target.status, p_actor_id, target.invoice_kind, target.renewal_source_invoice_id,
            target.renewal_period_date, target.renewal_items, target.renewal_late_fee, target.renewal_late_fee_accepted);
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
            customer_note = target.customer_note, status = target.status,
            renewal_items = target.renewal_items, renewal_late_fee = target.renewal_late_fee,
            renewal_late_fee_accepted = target.renewal_late_fee_accepted
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
            if paid_amount > phase_amount then
                raise exception 'invoice_validation: correct recorded receipts before reducing a milestone below its received amount';
            end if;
            if phase_paid and paid_amount < phase_amount then
                insert into public.payments(invoice_id, milestone_id, amount, currency, method, reference, paid_at, created_by)
                    values(target_id, phase_id, phase_amount - paid_amount, target.currency, target.payment_method,
                           'Invoice phase payment', coalesce((phase->>'paid_at')::timestamptz, now()), p_actor_id);
            elsif phase_paid and phase->>'paid_at' is not null and paid_amount >= phase_amount then
                -- The date shown in the phase editor represents the latest linked receipt.
                update public.payments set paid_at = (phase->>'paid_at')::timestamptz
                where id = (select id from public.payments where milestone_id = phase_id
                            order by paid_at desc, created_at desc, id desc limit 1)
                  and paid_at is distinct from (phase->>'paid_at')::timestamptz;
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
    if paid_amount > target.project_value then
        raise exception 'invoice_validation: project value cannot be lower than recorded receipts';
    end if;
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

-- Lock the source before checking for an existing bill; concurrent clicks/retries reuse it.
create or replace function public.create_renewal_invoice(
    p_source_id uuid, p_period_date date, p_fields jsonb, p_actor_id uuid
) returns setof public.invoices language plpgsql security definer set search_path = public as $$
declare
    source public.invoices;
    existing public.invoices;
    total numeric;
begin
    select * into source from public.invoices where id = p_source_id for update;
    if not found then raise exception 'invoice_not_found'; end if;
    if source.invoice_kind <> 'project' or source.status = 'void' then
        raise exception 'invoice_validation: choose an active project invoice as the renewal source';
    end if;
    if source.renewal_due_date is distinct from p_period_date then
        raise exception 'invoice_validation: reload the source invoice because its renewal date changed';
    end if;
    select * into existing from public.invoices
        where renewal_source_invoice_id = p_source_id and renewal_period_date = p_period_date and status <> 'void';
    if found then
        return next existing;
        return;
    end if;
    total := (p_fields->>'project_value')::numeric;
    return query select * from public.save_invoice_document(null,
        p_fields || jsonb_build_object('invoice_kind', 'renewal', 'client_id', source.client_id,
            'renewal_source_invoice_id', source.id, 'renewal_period_date', p_period_date,
            'agreement_id', source.agreement_id, 'status', 'sent'),
        jsonb_build_array(jsonb_build_object('name', 'Renewal payment', 'amount', total, 'is_paid', false)),
        null, p_actor_id, null);
end;
$$;
revoke all on function public.create_renewal_invoice(uuid, date, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_renewal_invoice(uuid, date, jsonb, uuid) to service_role;

commit;
