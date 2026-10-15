-- Count successful public proposal/quotation and agreement link opens.
-- Keep counters outside agreements so signed records and legacy signed checks
-- remain untouched by later reads.
begin;

create table public.document_open_counts (
    document_type text not null check (document_type in ('agreement', 'proposal')),
    document_id uuid not null,
    open_count bigint not null default 0 check (open_count >= 0),
    last_opened_at timestamptz,
    primary key (document_type, document_id)
);

-- Earlier releases recorded only the first known open. A signed agreement
-- also implies at least one open, even if an older link copy cleared its
-- viewed_at. Older repeat opens cannot be reconstructed.
insert into public.document_open_counts (document_type, document_id, open_count, last_opened_at)
select 'agreement', id, 1, viewed_at from public.agreements
where viewed_at is not null or status = 'signed';

insert into public.document_open_counts (document_type, document_id, open_count, last_opened_at)
select 'proposal', id, 1, viewed_at from public.proposals where viewed_at is not null;

-- Audit entries cover first opens of earlier links, including links whose
-- viewed_at was later cleared by an edit or replacement.
insert into public.document_open_counts as counter (document_type, document_id, open_count, last_opened_at)
select 'agreement', a.id, count(*)::bigint, max(log.created_at)
from public.audit_logs as log
join public.agreements as a on log.entity_id = a.id::text
where log.entity_type = 'agreement' and log.action = 'view'
group by a.id
on conflict (document_type, document_id) do update
    set open_count = greatest(counter.open_count, excluded.open_count),
        last_opened_at = greatest(counter.last_opened_at, excluded.last_opened_at);

insert into public.document_open_counts as counter (document_type, document_id, open_count, last_opened_at)
select 'proposal', p.id, count(*)::bigint, max(log.created_at)
from public.audit_logs as log
join public.proposals as p on log.entity_id = p.id::text
where log.entity_type = 'proposal' and log.action = 'view'
group by p.id
on conflict (document_type, document_id) do update
    set open_count = greatest(counter.open_count, excluded.open_count),
        last_opened_at = greatest(counter.last_opened_at, excluded.last_opened_at);

alter table public.document_open_counts enable row level security;
create policy document_open_counts_admin_read on public.document_open_counts
for select to authenticated using (public.is_admin());

grant select on public.document_open_counts to authenticated;
grant all on public.document_open_counts to service_role;

-- The service API calls this only after resolving the possession token. The
-- locked document row rechecks its hash so a concurrent link rotation cannot
-- count or return a revoked link. UPSERT increments atomically under load.
create function public.record_document_open(
    p_document_type text,
    p_document_id uuid,
    p_access_token_hash text
)
returns table (document_status text, first_viewed_at timestamptz, view_count bigint, last_opened_at timestamptz, first_opened boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_status text;
    v_first_viewed_at timestamptz;
    v_count bigint;
    v_last_opened_at timestamptz;
    v_first_opened boolean := false;
    v_now timestamptz;
begin
    if p_document_type = 'agreement' then
        select a.status::text, a.viewed_at into v_status, v_first_viewed_at
        from public.agreements as a
        where a.id = p_document_id and a.deleted_at is null
          and a.access_token_hash = p_access_token_hash
          and a.status in ('sent', 'viewed', 'signed', 'expired')
        for update;
        if not found then return; end if;
        v_now := clock_timestamp();
        if v_status = 'sent' then
            v_first_opened := true;
            update public.agreements as a
            set status = 'viewed', viewed_at = v_now
            where a.id = p_document_id
            returning a.status::text, a.viewed_at into v_status, v_first_viewed_at;
        end if;
    elsif p_document_type = 'proposal' then
        select p.status, p.viewed_at into v_status, v_first_viewed_at
        from public.proposals as p
        where p.id = p_document_id and p.deleted_at is null
          and p.access_token_hash = p_access_token_hash
          and p.status in ('sent', 'viewed')
        for update;
        if not found then return; end if;
        v_now := clock_timestamp();
        if v_status = 'sent' then
            v_first_opened := true;
            update public.proposals as p
            set status = 'viewed', viewed_at = v_now
            where p.id = p_document_id
            returning p.status, p.viewed_at into v_status, v_first_viewed_at;
        end if;
    else
        raise exception 'Unsupported document type' using errcode = '22023';
    end if;

    insert into public.document_open_counts as counter
        (document_type, document_id, open_count, last_opened_at)
    values (p_document_type, p_document_id, 1, v_now)
    on conflict (document_type, document_id) do update
        set open_count = counter.open_count + 1,
            last_opened_at = excluded.last_opened_at
    returning counter.open_count, counter.last_opened_at into v_count, v_last_opened_at;

    return query select v_status, v_first_viewed_at, v_count, v_last_opened_at, v_first_opened;
end;
$$;

revoke all on function public.record_document_open(text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_document_open(text, uuid, text) to service_role;

comment on table public.document_open_counts is
    'Cumulative successful public link opens. Historical rows use known first-open audit events and viewed timestamps; earlier repeat opens cannot be recovered. An open does not prove a particular person read the document.';

commit;
