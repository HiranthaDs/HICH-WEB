begin;

-- Default signup profiles never confer portal access. Only the backend may grant it.
alter table public.profiles add column if not exists portal_access boolean not null default false;
update public.profiles set portal_access = true where role = 'admin';

alter table public.agreements add column if not exists source_invoice_id uuid references public.invoices(id) on delete set null;
alter table public.agreements add column if not exists visiting_fee_lkr numeric(14,2) not null default 0
    check (visiting_fee_lkr = 0 or visiting_fee_lkr between 5000 and 15000);
alter table public.agreements add column if not exists payment_schedule jsonb not null default '[]'::jsonb;
alter table public.agreements add column if not exists payment_instructions text;
alter table public.agreements add column if not exists project_due_date date;

-- Keep privileges on the new access flag backend-only even when profile self-edit is enabled.
create or replace function public.protect_portal_access() returns trigger
language plpgsql set search_path = public as $$
begin
    if auth.role() is distinct from 'service_role' and current_user not in ('postgres', 'supabase_admin') then
        if tg_op = 'INSERT' then
            new.portal_access := false;
        elsif new.portal_access is distinct from old.portal_access or new.active is distinct from old.active then
            raise exception 'Only the service role can change portal access';
        end if;
    end if;
    return new;
end;
$$;
create trigger profiles_protect_portal_access before insert or update on public.profiles
for each row execute function public.protect_portal_access();

create or replace function public.agreement_document_version()
returns trigger language plpgsql set search_path = public as $$
begin
    if row(old.reference, old.client_id, old.client_name, old.client_email, old.client_phone,
           old.project_id, old.title, old.project_title, old.description, old.terms,
           old.amount, old.currency, old.expires_at, old.renewal_amount, old.renewal_currency, old.renewal_due_date, old.source_invoice_id, old.visiting_fee_lkr, old.payment_schedule, old.payment_instructions, old.project_due_date)
       is distinct from
       row(new.reference, new.client_id, new.client_name, new.client_email, new.client_phone,
           new.project_id, new.title, new.project_title, new.description, new.terms,
           new.amount, new.currency, new.expires_at, new.renewal_amount, new.renewal_currency, new.renewal_due_date, new.source_invoice_id, new.visiting_fee_lkr, new.payment_schedule, new.payment_instructions, new.project_due_date) then
        new.version := old.version + 1;
    else
        new.version := old.version;
    end if;
    if old.status <> 'signed' and
       row(old.client_id, old.client_name, old.client_email, old.client_phone)
       is distinct from row(new.client_id, new.client_name, new.client_email, new.client_phone) then
        new.access_token_hash := null;
        new.status := 'draft';
        new.sent_at := null;
        new.viewed_at := null;
    end if;
    if new.status = 'signed' and old.status <> 'signed' then
        if old.status not in ('sent', 'viewed') then
            raise exception 'Only a shared agreement can be signed' using errcode = '23514';
        end if;
        if new.expires_at is not null and new.expires_at <= now() then
            raise exception 'The agreement has expired' using errcode = '23514';
        end if;
        if new.version <> old.version then
            raise exception 'Content cannot change during signing' using errcode = '23514';
        end if;
    end if;
    return new;
end;
$$;

create or replace function public.capture_agreement_version()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.agreement_versions (agreement_id, version, snapshot, content_sha256, created_by)
    values (new.id, new.version, jsonb_build_object(
        'reference', new.reference, 'client_id', new.client_id,
        'client_name', new.client_name, 'client_email', new.client_email, 'client_phone', new.client_phone,
        'project_id', new.project_id, 'title', new.title, 'project_title', new.project_title,
        'description', new.description, 'terms', new.terms, 'amount', new.amount,
        'currency', new.currency, 'expires_at', new.expires_at, 'version', new.version,
        'renewal_amount', new.renewal_amount, 'renewal_currency', new.renewal_currency, 'renewal_due_date', new.renewal_due_date, 'source_invoice_id', new.source_invoice_id, 'visiting_fee_lkr', new.visiting_fee_lkr, 'payment_schedule', new.payment_schedule, 'payment_instructions', new.payment_instructions, 'project_due_date', new.project_due_date
    ), new.content_sha256, new.created_by);
    return new;
end;
$$;


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
        if (new.paid_at at time zone 'Asia/Colombo')::date > (now() at time zone 'Asia/Colombo')::date then
            raise exception 'invoice_validation: a received payment cannot have a future date';
        end if;
        if new.amount + coalesce((select sum(amount) from public.payments where invoice_id = new.invoice_id and id <> new.id), 0) > parent.project_value then
            raise exception 'invoice_validation: payment exceeds the remaining invoice balance';
        end if;
        if new.milestone_id is not null and new.amount + coalesce((select sum(amount) from public.payments where milestone_id = new.milestone_id and id <> new.id), 0) > (select amount from public.invoice_milestones where id = new.milestone_id and invoice_id = new.invoice_id) then
            raise exception 'invoice_validation: payment exceeds the remaining milestone balance';
        end if;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;

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

commit;
