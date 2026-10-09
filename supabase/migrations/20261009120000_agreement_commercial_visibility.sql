-- Allow one agreement workflow to produce either a complete commercial document
-- or a scope-only client document while retaining the internal project record.
begin;

alter table public.agreements
    add column commercial_details_visible boolean not null default true;

create or replace function public.agreement_document_version()
returns trigger language plpgsql set search_path = public as $$
begin
    if row(old.reference, old.client_id, old.client_name, old.client_email, old.client_phone,
           old.project_id, old.title, old.project_title, old.description, old.terms,
           old.amount, old.currency, old.commercial_details_visible, old.expires_at,
           old.renewal_amount, old.renewal_currency, old.renewal_due_date,
           old.source_invoice_id, old.visiting_fee_lkr, old.payment_schedule,
           old.payment_instructions, old.project_due_date)
       is distinct from
       row(new.reference, new.client_id, new.client_name, new.client_email, new.client_phone,
           new.project_id, new.title, new.project_title, new.description, new.terms,
           new.amount, new.currency, new.commercial_details_visible, new.expires_at,
           new.renewal_amount, new.renewal_currency, new.renewal_due_date,
           new.source_invoice_id, new.visiting_fee_lkr, new.payment_schedule,
           new.payment_instructions, new.project_due_date) then
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
        'currency', new.currency, 'commercial_details_visible', new.commercial_details_visible,
        'expires_at', new.expires_at, 'version', new.version,
        'renewal_amount', new.renewal_amount, 'renewal_currency', new.renewal_currency,
        'renewal_due_date', new.renewal_due_date, 'source_invoice_id', new.source_invoice_id,
        'visiting_fee_lkr', new.visiting_fee_lkr, 'payment_schedule', new.payment_schedule,
        'payment_instructions', new.payment_instructions, 'project_due_date', new.project_due_date
    ), new.content_sha256, new.created_by);
    return new;
end;
$$;

comment on column public.agreements.commercial_details_visible is
    'True includes project and renewal commercial figures in the client document; false creates a scope-only client document.';

commit;
