-- Agreement document identities, client snapshots and optimistic signing locks.
-- Run after the initial schema. Existing signed PDFs/evidence remain untouched.
begin;

alter table public.agreements
    add column reference text check (reference is null or char_length(reference) between 1 and 80),
    add column client_name text check (client_name is null or char_length(client_name) between 1 and 160),
    add column client_email citext,
    add column client_phone text check (client_phone is null or char_length(client_phone) between 3 and 40),
    add column signer_job_role text check (signer_job_role is null or char_length(signer_job_role) between 2 and 160),
    add column version integer not null default 1 check (version > 0),
    add column signed_snapshot jsonb,
    add column consent_accepted boolean not null default false,
    add column renewal_amount numeric(14,2) check (renewal_amount is null or renewal_amount >= 0),
    add column renewal_currency varchar(3) not null default 'LKR' check (renewal_currency in ('LKR', 'USD')),
    add column renewal_due_date date;

create unique index agreements_reference_unique on public.agreements (lower(reference)) where reference is not null;

-- Preserve the sequence of historical content versions without modifying signed
-- rows: they retain their existing immutable evidence and public UUID reference.
update public.agreements a
set version = coalesce((select max(v.version) from public.agreement_versions v where v.agreement_id = a.id), 1)
where a.status <> 'signed';

create or replace function public.agreement_document_version()
returns trigger language plpgsql set search_path = public as $$
begin
    if row(old.reference, old.client_id, old.client_name, old.client_email, old.client_phone,
           old.project_id, old.title, old.project_title, old.description, old.terms,
           old.amount, old.currency, old.expires_at, old.renewal_amount, old.renewal_currency, old.renewal_due_date)
       is distinct from
       row(new.reference, new.client_id, new.client_name, new.client_email, new.client_phone,
           new.project_id, new.title, new.project_title, new.description, new.terms,
           new.amount, new.currency, new.expires_at, new.renewal_amount, new.renewal_currency, new.renewal_due_date) then
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

create trigger agreement_document_version_before_update
before update on public.agreements for each row execute function public.agreement_document_version();

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
        'renewal_amount', new.renewal_amount, 'renewal_currency', new.renewal_currency, 'renewal_due_date', new.renewal_due_date
    ), new.content_sha256, new.created_by);
    return new;
end;
$$;

drop trigger capture_agreement_version_after_content_update on public.agreements;
create trigger capture_agreement_version_after_content_update
after update on public.agreements for each row
when (old.version is distinct from new.version)
execute function public.capture_agreement_version();

-- NOT VALID leaves legacy signed records intact while enforcing complete evidence
-- on every new signing operation. The original immutability trigger still rejects
-- any update/delete of signed rows, including service-role operations.
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
        and (signed_snapshot ->> 'amount') is not null
        and ((signature_type = 'typed' and char_length(trim(typed_signature)) >= 2 and signature_storage_path is null)
             or (signature_type = 'drawn' and signature_storage_path is not null and typed_signature is null))
    ), false)
) not valid;

create or replace function public.protect_signed_agreement_versions()
returns trigger language plpgsql set search_path = public as $$
begin
    if exists (select 1 from public.agreements where id = old.agreement_id and status = 'signed') then
        raise exception 'Signed agreement versions are immutable' using errcode = '55000';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
end;
$$;

create trigger protect_signed_agreement_versions_before_change
before update or delete on public.agreement_versions
for each row execute function public.protect_signed_agreement_versions();

comment on column public.agreements.signed_snapshot is 'Fixed commercial document and consent metadata captured when the client signs; never joined to later CRM edits.';
comment on column public.agreements.version is 'Monotonic commercial-content revision, compared atomically at signing to prevent consent to stale terms.';

commit;
