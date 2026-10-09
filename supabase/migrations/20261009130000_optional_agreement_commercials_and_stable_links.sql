-- Permit agreements without a stated price and keep copied signing links stable.
-- This follows the visibility migration so it is safe even if that migration was
-- already applied before the optional-commercial-details release.
begin;

alter table public.agreements
    add column if not exists share_nonce uuid;

-- Identity, consent, version and signature evidence remain mandatory. The
-- agreement amount is intentionally absent from this constraint because a
-- scope agreement or separately quoted engagement may not state a price.
alter table public.agreements
    drop constraint if exists signed_agreement_has_complete_snapshot;

alter table public.agreements add constraint signed_agreement_has_complete_snapshot check (
    status <> 'signed' or coalesce((
        signer_job_role is not null
        and char_length(trim(signer_job_role)) >= 2
        and char_length(trim(signer_name)) >= 2
        and consent_accepted is true
        and consent_text is not null
        and signed_snapshot is not null
        and jsonb_typeof(signed_snapshot) = 'object'
        and signed_snapshot ->> 'signer_name' = signer_name
        and signed_snapshot ->> 'signer_job_role' = signer_job_role
        and signed_snapshot ->> 'content_sha256' = content_sha256
        and (signed_snapshot ->> 'version')::integer = version
        and signed_snapshot ->> 'consent_accepted' = 'true'
        and (signed_snapshot ->> 'client_phone') is not null
        and (signed_snapshot ->> 'client_name') is not null
        and (signed_snapshot ->> 'project_title') is not null
        and ((signature_type = 'typed' and char_length(trim(typed_signature)) >= 2 and signature_storage_path is null)
             or (signature_type = 'drawn' and signature_storage_path is not null and typed_signature is null))
    ), false)
) not valid;

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

comment on column public.agreements.share_nonce is
    'Server-side nonce used to derive a stable signing bearer token without storing the token itself.';

commit;
