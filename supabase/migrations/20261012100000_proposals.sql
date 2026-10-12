-- Store AI-authored proposal and quotation HTML as isolated, shareable documents.
begin;

create table public.proposals (
    id uuid primary key default gen_random_uuid(),
    public_id uuid not null default gen_random_uuid() unique,
    client_id uuid not null references public.clients(id) on delete restrict,
    client_name text not null check (char_length(client_name) between 1 and 200),
    client_email citext,
    client_phone text check (client_phone is null or char_length(client_phone) <= 40),
    reference text not null unique check (char_length(reference) between 1 and 80 and reference ~ '^[A-Za-z0-9][A-Za-z0-9_./-]*$'),
    title text not null check (char_length(title) between 1 and 240),
    html_content text not null check (char_length(html_content) between 20 and 2000000),
    content_sha256 char(64) not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
    status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'archived')),
    version integer not null default 1 check (version >= 1),
    access_token_hash char(64) unique check (access_token_hash is null or access_token_hash ~ '^[a-f0-9]{64}$'),
    share_nonce uuid,
    sent_at timestamptz,
    viewed_at timestamptz,
    deleted_at timestamptz,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint proposal_share_state check (
        (status = 'draft' and access_token_hash is null and share_nonce is null)
        or (status in ('sent', 'viewed') and access_token_hash is not null and share_nonce is not null)
        or status = 'archived'
    )
);

create index proposals_client_idx on public.proposals(client_id, created_at desc);
create index proposals_status_idx on public.proposals(status, created_at desc);
create index proposals_token_hash_idx on public.proposals(access_token_hash) where access_token_hash is not null;

create trigger proposals_set_updated_at before update on public.proposals
for each row execute function public.set_updated_at();

alter table public.proposals enable row level security;
create policy proposals_admin_manage on public.proposals
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.proposals to authenticated;
grant all on public.proposals to service_role;

comment on column public.proposals.html_content is
    'Complete standalone HTML displayed only inside a browser sandbox without same-origin access.';
comment on column public.proposals.access_token_hash is
    'SHA-256 lookup digest for the possession-based public proposal link; the bearer token is never stored.';

commit;
