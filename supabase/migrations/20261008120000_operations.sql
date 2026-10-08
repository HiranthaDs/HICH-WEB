begin;

create table public.operation_tasks (
    id uuid primary key default gen_random_uuid(),
    title text not null check (char_length(title) between 2 and 240),
    client_id uuid references public.clients(id) on delete set null,
    due_date date,
    priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
    status text not null default 'open' check (status in ('open', 'done')),
    notes text,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now()
);
create index operation_tasks_open_due on public.operation_tasks(due_date) where status = 'open';

create table public.change_orders (
    id uuid primary key default gen_random_uuid(),
    agreement_id uuid not null references public.agreements(id) on delete restrict,
    reference text not null unique,
    project_title text,
    title text not null,
    description text not null,
    amount numeric(14,2) not null check (amount >= 0),
    currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
    extra_days integer not null default 0 check (extra_days >= 0),
    status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'void')),
    access_token_hash char(64) unique,
    signer_name text,
    signer_job_role text,
    signer_ip text,
    signer_user_agent text,
    consent boolean not null default false,
    consent_text text,
    approved_at timestamptz,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint approved_change_evidence check (status <> 'approved' or (consent and signer_name is not null and signer_job_role is not null and approved_at is not null))
);

create function public.protect_approved_change() returns trigger language plpgsql set search_path = public as $$
begin
    if tg_op = 'INSERT' then
        if new.status <> 'draft' then raise exception 'New changes must be draft'; end if;
    else
    if old.status = 'approved' then
        raise exception 'Approved scope changes are immutable';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    if old.status in ('sent', 'void') and
       row(old.agreement_id, old.title, old.description, old.amount, old.currency, old.extra_days, old.reference, old.project_title)
       is distinct from row(new.agreement_id, new.title, new.description, new.amount, new.currency, new.extra_days, new.reference, new.project_title) then
        raise exception 'Shared change terms are immutable; withdraw and create a new change';
    end if;
    if new.status = 'approved' and old.status <> 'sent' then raise exception 'Only a sent change can be approved'; end if;
    if old.status = 'void' then raise exception 'Withdrawn changes are immutable'; end if;
    end if;
    if not exists(select 1 from public.agreements where id = new.agreement_id and status = 'signed' and currency = new.currency) then
        raise exception 'A signed agreement in the same currency is required';
    end if;
    return new;
end;
$$;
create trigger immutable_scope_approval before insert or update or delete on public.change_orders for each row execute function public.protect_approved_change();

create table public.portfolio_collections (
    id uuid primary key default gen_random_uuid(),
    public_id uuid not null default gen_random_uuid() unique,
    title text not null,
    description text,
    category text,
    project_ids uuid[] not null check (cardinality(project_ids) between 1 and 100),
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now()
);

alter table public.operation_tasks enable row level security;
alter table public.change_orders enable row level security;
alter table public.portfolio_collections enable row level security;
-- All access uses the authenticated FastAPI boundary and its server-only service role.
revoke all on public.operation_tasks, public.change_orders, public.portfolio_collections from anon, authenticated;
grant all on public.operation_tasks, public.change_orders, public.portfolio_collections to service_role;

commit;
