begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.app_role as enum ('admin', 'staff', 'client');
create type public.client_status as enum ('lead', 'active', 'inactive', 'archived');
create type public.agreement_status as enum ('draft', 'sent', 'viewed', 'signed', 'void', 'expired');
create type public.invoice_status as enum ('draft', 'sent', 'partial', 'paid', 'overdue', 'void');
create type public.milestone_status as enum ('pending', 'invoiced', 'paid', 'waived');

create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email citext not null unique,
    full_name text,
    role public.app_role not null default 'staff',
    active boolean not null default true,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.clients (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(name) between 1 and 160),
    company text check (company is null or char_length(company) <= 200),
    email citext,
    phone text check (phone is null or char_length(phone) <= 40),
    address text check (address is null or char_length(address) <= 1000),
    status public.client_status not null default 'active',
    notes text check (notes is null or char_length(notes) <= 5000),
    metadata jsonb not null default '{}'::jsonb,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.portfolio_projects (
    id uuid primary key default gen_random_uuid(),
    project_code text not null unique check (project_code ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'),
    title text not null check (char_length(title) between 1 and 240),
    slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    url text,
    main_description text not null check (char_length(main_description) between 1 and 10000),
    sub_description text check (sub_description is null or char_length(sub_description) <= 10000),
    category text check (category is null or char_length(category) <= 120),
    featured boolean not null default false,
    published boolean not null default false,
    sort_order integer not null default 0,
    metadata jsonb not null default '{}'::jsonb,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.portfolio_images (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.portfolio_projects(id) on delete cascade,
    storage_path text not null unique,
    alt_text text check (alt_text is null or char_length(alt_text) <= 300),
    position integer not null default 0 check (position >= 0),
    is_cover boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index portfolio_one_cover_per_project
    on public.portfolio_images(project_id) where is_cover;

create table public.agreements (
    id uuid primary key default gen_random_uuid(),
    public_id uuid not null default gen_random_uuid() unique,
    client_id uuid not null references public.clients(id) on delete restrict,
    project_id uuid references public.portfolio_projects(id) on delete set null,
    title text not null check (char_length(title) between 1 and 240),
    project_title text check (project_title is null or char_length(project_title) <= 240),
    description text not null check (char_length(description) between 20 and 100000),
    terms jsonb not null default '{}'::jsonb,
    amount numeric(14,2) check (amount is null or amount >= 0),
    currency varchar(3) not null default 'LKR' check (currency ~ '^[A-Z]{3}$'),
    status public.agreement_status not null default 'draft',
    expires_at timestamptz,
    sent_at timestamptz,
    viewed_at timestamptz,
    signed_at timestamptz,
    access_token_hash char(64) unique,
    content_sha256 char(64) not null,
    signer_name text check (signer_name is null or char_length(signer_name) <= 160),
    signer_email citext,
    signature_type text check (signature_type is null or signature_type in ('typed', 'drawn')),
    typed_signature text check (typed_signature is null or char_length(typed_signature) <= 160),
    signature_storage_path text,
    signature_sha256 char(64),
    signed_record_sha256 char(64),
    signed_pdf_storage_path text,
    signed_pdf_sha256 char(64),
    signer_ip text check (signer_ip is null or char_length(signer_ip) <= 64),
    signer_user_agent text check (signer_user_agent is null or char_length(signer_user_agent) <= 500),
    consent_text text,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint signed_agreement_has_evidence check (
        status <> 'signed' or (
            signed_at is not null
            and signer_name is not null
            and signature_sha256 is not null
            and signed_record_sha256 is not null
            and signed_pdf_storage_path is not null
            and signed_pdf_sha256 is not null
        )
    )
);

create table public.agreement_versions (
    id bigint generated always as identity primary key,
    agreement_id uuid not null references public.agreements(id) on delete cascade,
    version integer not null check (version > 0),
    snapshot jsonb not null,
    content_sha256 char(64) not null,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (agreement_id, version)
);

create table public.invoices (
    id uuid primary key default gen_random_uuid(),
    invoice_number text not null unique check (char_length(invoice_number) between 1 and 80),
    client_id uuid not null references public.clients(id) on delete restrict,
    agreement_id uuid references public.agreements(id) on delete set null,
    project_title text check (project_title is null or char_length(project_title) <= 240),
    currency varchar(3) not null default 'LKR' check (currency ~ '^[A-Z]{3}$'),
    project_value numeric(14,2) not null check (project_value > 0),
    renewal_amount numeric(14,2) check (renewal_amount is null or renewal_amount >= 0),
    renewal_currency varchar(3) check (renewal_currency is null or renewal_currency ~ '^[A-Z]{3}$'),
    renewal_due_date date,
    issue_date date not null default current_date,
    due_date date,
    payment_method text check (payment_method is null or char_length(payment_method) <= 120),
    notes text check (notes is null or char_length(notes) <= 5000),
    status public.invoice_status not null default 'draft',
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (due_date is null or due_date >= issue_date)
);

create table public.invoice_milestones (
    id uuid primary key default gen_random_uuid(),
    invoice_id uuid not null references public.invoices(id) on delete cascade,
    title text not null check (char_length(title) between 1 and 240),
    description text check (description is null or char_length(description) <= 2000),
    amount numeric(14,2) not null check (amount > 0),
    due_date date,
    status public.milestone_status not null default 'pending',
    position integer not null default 0 check (position >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.payments (
    id uuid primary key default gen_random_uuid(),
    invoice_id uuid not null references public.invoices(id) on delete cascade,
    milestone_id uuid references public.invoice_milestones(id) on delete set null,
    amount numeric(14,2) not null check (amount > 0),
    currency varchar(3) not null default 'LKR' check (currency ~ '^[A-Z]{3}$'),
    method text check (method is null or char_length(method) <= 120),
    reference text check (reference is null or char_length(reference) <= 240),
    paid_at timestamptz not null,
    notes text check (notes is null or char_length(notes) <= 2000),
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.audit_logs (
    id bigint generated always as identity primary key,
    actor_user_id uuid references public.profiles(id) on delete set null,
    action text not null check (char_length(action) between 1 and 100),
    entity_type text not null check (char_length(entity_type) between 1 and 100),
    entity_id text,
    request_id text,
    ip_address text,
    user_agent text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index clients_status_idx on public.clients(status);
create index clients_created_at_idx on public.clients(created_at desc);
create index clients_email_idx on public.clients(email) where email is not null;
create index portfolio_public_order_idx on public.portfolio_projects(published, sort_order, created_at desc);
create index portfolio_images_project_idx on public.portfolio_images(project_id, position);
create index agreements_client_idx on public.agreements(client_id, created_at desc);
create index agreements_status_idx on public.agreements(status, expires_at);
create index agreements_token_hash_idx on public.agreements(access_token_hash) where access_token_hash is not null;
create index agreement_versions_agreement_idx on public.agreement_versions(agreement_id, version desc);
create index invoices_client_idx on public.invoices(client_id, created_at desc);
create index invoices_status_due_idx on public.invoices(status, due_date);
create index milestones_invoice_idx on public.invoice_milestones(invoice_id, position);
create index payments_invoice_idx on public.payments(invoice_id, paid_at desc);
create index payments_milestone_idx on public.payments(milestone_id) where milestone_id is not null;
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_entity_idx on public.audit_logs(entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs(actor_user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger clients_set_updated_at before update on public.clients
for each row execute function public.set_updated_at();
create trigger projects_set_updated_at before update on public.portfolio_projects
for each row execute function public.set_updated_at();
create trigger portfolio_images_set_updated_at before update on public.portfolio_images
for each row execute function public.set_updated_at();
create trigger agreements_set_updated_at before update on public.agreements
for each row execute function public.set_updated_at();
create trigger invoices_set_updated_at before update on public.invoices
for each row execute function public.set_updated_at();
create trigger milestones_set_updated_at before update on public.invoice_milestones
for each row execute function public.set_updated_at();
create trigger payments_set_updated_at before update on public.payments
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.email is null then
        return new;
    end if;
    insert into public.profiles (id, email, full_name, role)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
        'staff'
    )
    on conflict (id) do update
        set email = excluded.email,
            full_name = coalesce(excluded.full_name, public.profiles.full_name);
    return new;
end;
$$;

create trigger on_auth_user_created
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function public.handle_new_auth_user();

-- The trigger above handles future users. Backfill users that existed before this
-- schema was installed so API writes never reference a missing profile row.
insert into public.profiles (id, email, full_name, role)
select
    id,
    email,
    coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name'),
    'staff'::public.app_role
from auth.users
where email is not null
on conflict (id) do update
set email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'admin' and active = true
    );
$$;

create or replace function public.capture_agreement_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    next_version integer;
begin
    select coalesce(max(version), 0) + 1 into next_version
    from public.agreement_versions where agreement_id = new.id;

    insert into public.agreement_versions (
        agreement_id, version, snapshot, content_sha256, created_by
    ) values (
        new.id,
        next_version,
        jsonb_build_object(
            'client_id', new.client_id,
            'project_id', new.project_id,
            'title', new.title,
            'project_title', new.project_title,
            'description', new.description,
            'terms', new.terms,
            'amount', new.amount,
            'currency', new.currency,
            'expires_at', new.expires_at
        ),
        new.content_sha256,
        new.created_by
    );
    return new;
end;
$$;

create trigger capture_agreement_version_after_insert
after insert on public.agreements
for each row execute function public.capture_agreement_version();

create trigger capture_agreement_version_after_content_update
after update of client_id, project_id, title, project_title, description, terms, amount, currency, expires_at
on public.agreements
for each row
when (
    old.client_id is distinct from new.client_id
    or old.project_id is distinct from new.project_id
    or old.title is distinct from new.title
    or old.project_title is distinct from new.project_title
    or old.description is distinct from new.description
    or old.terms is distinct from new.terms
    or old.amount is distinct from new.amount
    or old.currency is distinct from new.currency
    or old.expires_at is distinct from new.expires_at
)
execute function public.capture_agreement_version();

create or replace function public.protect_signed_agreement()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if tg_op = 'DELETE' and old.status = 'signed' then
        raise exception 'Signed agreements are immutable' using errcode = '55000';
    end if;
    if tg_op = 'UPDATE' and old.status = 'signed' and new is distinct from old then
        raise exception 'Signed agreements are immutable' using errcode = '55000';
    end if;
    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

create trigger protect_signed_agreement_before_change
before update or delete on public.agreements
for each row execute function public.protect_signed_agreement();

create or replace function public.validate_payment_milestone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.milestone_id is not null and not exists (
        select 1 from public.invoice_milestones
        where id = new.milestone_id and invoice_id = new.invoice_id
    ) then
        raise exception 'Milestone does not belong to invoice' using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger validate_payment_milestone_before_write
before insert or update on public.payments
for each row execute function public.validate_payment_milestone();

create or replace function public.recalculate_invoice_payment_status()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    target_invoice uuid;
    target_milestone uuid;
    paid_total numeric(14,2);
    invoice_total numeric(14,2);
    milestone_paid numeric(14,2);
    milestone_total numeric(14,2);
begin
    target_invoice := coalesce(new.invoice_id, old.invoice_id);
    target_milestone := coalesce(new.milestone_id, old.milestone_id);

    select coalesce(sum(amount), 0) into paid_total
    from public.payments where invoice_id = target_invoice;
    select project_value into invoice_total from public.invoices where id = target_invoice;

    update public.invoices
    set status = case
        when status = 'void' then 'void'::public.invoice_status
        when paid_total >= invoice_total then 'paid'::public.invoice_status
        when paid_total > 0 then 'partial'::public.invoice_status
        when status in ('paid', 'partial') then 'sent'::public.invoice_status
        else status
    end
    where id = target_invoice;

    if target_milestone is not null then
        select coalesce(sum(amount), 0) into milestone_paid
        from public.payments where milestone_id = target_milestone;
        select amount into milestone_total from public.invoice_milestones where id = target_milestone;
        update public.invoice_milestones
        set status = case
            when status = 'waived' then status
            when milestone_paid >= milestone_total then 'paid'::public.milestone_status
            when status = 'paid' and milestone_paid < milestone_total then 'invoiced'::public.milestone_status
            else status
        end
        where id = target_milestone;
    end if;
    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

create trigger recalculate_invoice_after_payment
after insert or update or delete on public.payments
for each row execute function public.recalculate_invoice_payment_status();

alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.portfolio_projects enable row level security;
alter table public.portfolio_images enable row level security;
alter table public.agreements enable row level security;
alter table public.agreement_versions enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_milestones enable row level security;
alter table public.payments enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_read_self_or_admin on public.profiles
for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_admin_manage on public.profiles
for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy clients_admin_manage on public.clients
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy projects_admin_manage on public.portfolio_projects
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy projects_public_read on public.portfolio_projects
for select to anon, authenticated using (published = true);
create policy images_admin_manage on public.portfolio_images
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy images_public_read on public.portfolio_images
for select to anon, authenticated using (
    exists (
        select 1 from public.portfolio_projects p
        where p.id = portfolio_images.project_id and p.published = true
    )
);
create policy agreements_admin_manage on public.agreements
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy agreement_versions_admin_read on public.agreement_versions
for select to authenticated using (public.is_admin());
create policy invoices_admin_manage on public.invoices
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy milestones_admin_manage on public.invoice_milestones
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy payments_admin_manage on public.payments
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy audit_admin_read on public.audit_logs
for select to authenticated using (public.is_admin());
create policy audit_admin_insert on public.audit_logs
for insert to authenticated with check (public.is_admin() and actor_user_id = auth.uid());

grant usage on schema public to anon, authenticated, service_role;
grant select on public.portfolio_projects, public.portfolio_images to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on function public.is_admin() to anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
    ('portfolio-assets', 'portfolio-assets', true, 6000000, array['image/png', 'image/jpeg', 'image/webp']),
    ('agreement-signatures', 'agreement-signatures', false, 1500000, array['image/png', 'image/jpeg', 'image/webp']),
    ('agreement-pdfs', 'agreement-pdfs', false, 10000000, array['application/pdf'])
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy portfolio_assets_public_read on storage.objects
for select to anon, authenticated using (bucket_id = 'portfolio-assets');
create policy portfolio_assets_admin_insert on storage.objects
for insert to authenticated with check (bucket_id = 'portfolio-assets' and public.is_admin());
create policy portfolio_assets_admin_update on storage.objects
for update to authenticated using (bucket_id = 'portfolio-assets' and public.is_admin())
with check (bucket_id = 'portfolio-assets' and public.is_admin());
create policy portfolio_assets_admin_delete on storage.objects
for delete to authenticated using (bucket_id = 'portfolio-assets' and public.is_admin());

create policy agreement_signatures_admin_read on storage.objects
for select to authenticated using (bucket_id = 'agreement-signatures' and public.is_admin());
create policy agreement_signatures_admin_insert on storage.objects
for insert to authenticated with check (bucket_id = 'agreement-signatures' and public.is_admin());
create policy agreement_signatures_admin_delete on storage.objects
for delete to authenticated using (bucket_id = 'agreement-signatures' and public.is_admin());

create policy agreement_pdfs_admin_read on storage.objects
for select to authenticated using (bucket_id = 'agreement-pdfs' and public.is_admin());
create policy agreement_pdfs_admin_insert on storage.objects
for insert to authenticated with check (bucket_id = 'agreement-pdfs' and public.is_admin());
create policy agreement_pdfs_admin_delete on storage.objects
for delete to authenticated using (bucket_id = 'agreement-pdfs' and public.is_admin());

commit;
