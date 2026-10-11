-- Link lifetime is independent of invoice due dates and service renewal dates.
-- Preserve historical agreement deadlines because they are part of signed evidence.
begin;

update public.invoices set share_expires_at = null where share_expires_at is not null;

create or replace function public.publish_invoice_link(
    p_invoice_id uuid, p_nonce uuid, p_token_hash text, p_rotate boolean default false,
    p_expires_at timestamptz default null, p_set_expiry boolean default false
) returns setof public.invoices language plpgsql security definer set search_path = public as $$
declare
    invoice_record public.invoices;
    replace_link boolean;
begin
    select * into invoice_record from public.invoices where id = p_invoice_id for update;
    if not found or invoice_record.deleted_at is not null then raise exception 'invoice_not_found'; end if;
    if invoice_record.status = 'void' then raise exception 'invoice_void'; end if;
    if p_nonce is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
        raise exception 'invoice_validation: invalid link hash';
    end if;
    replace_link := p_rotate or not invoice_record.share_active or invoice_record.share_nonce is null or invoice_record.share_token_hash is null;
    update public.invoices set
        share_nonce = case when replace_link then p_nonce else share_nonce end,
        share_token_hash = case when replace_link then p_token_hash else share_token_hash end,
        share_expires_at = null,
        share_active = true,
        shared_at = coalesce(shared_at, now()),
        status = case when status = 'draft' then 'sent'::public.invoice_status else status end
    where id = p_invoice_id;
    return query select * from public.invoices where id = p_invoice_id;
end;
$$;

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
        new.share_nonce := null;
        new.status := 'draft';
        new.sent_at := null;
        new.viewed_at := null;
    end if;
    if new.status = 'signed' and old.status <> 'signed' then
        if old.status not in ('sent', 'viewed') then
            raise exception 'Only a shared agreement can be signed' using errcode = '23514';
        end if;
        if new.version <> old.version then
            raise exception 'Content cannot change during signing' using errcode = '23514';
        end if;
    end if;
    return new;
end;
$$;

update public.agreements set status = 'sent'
where status = 'expired' and deleted_at is null and access_token_hash is not null;

revoke all on function public.publish_invoice_link(uuid, uuid, text, boolean, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.publish_invoice_link(uuid, uuid, text, boolean, timestamptz, boolean) to service_role;
commit;
