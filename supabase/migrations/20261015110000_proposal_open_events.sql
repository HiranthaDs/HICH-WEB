-- Displayed proposal visits are recorded separately from document downloads.
-- An opening ID belongs to one mounted browser page and makes retries safe.
begin;

create table public.proposal_open_events (
    proposal_id uuid not null references public.proposals(id) on delete cascade,
    opening_id uuid not null,
    opened_at timestamptz not null default clock_timestamp(),
    primary key (proposal_id, opening_id)
);

alter table public.proposal_open_events enable row level security;
revoke all on public.proposal_open_events from public, anon, authenticated;
grant all on public.proposal_open_events to service_role;

create function public.record_proposal_open(
    p_proposal_id uuid,
    p_access_token_hash text,
    p_opening_id uuid
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
    -- Serialize opens per proposal and reject deleted, revoked and draft links.
    select p.status, p.viewed_at into v_status, v_first_viewed_at
    from public.proposals as p
    where p.id = p_proposal_id and p.deleted_at is null
      and p.access_token_hash = p_access_token_hash
      and p.status in ('sent', 'viewed')
    for update;
    if not found then return; end if;
    v_now := clock_timestamp();

    insert into public.proposal_open_events (proposal_id, opening_id, opened_at)
    values (p_proposal_id, p_opening_id, v_now)
    on conflict (proposal_id, opening_id) do nothing;

    if found then
        if v_status = 'sent' then
            v_first_opened := true;
            update public.proposals as p
            set status = 'viewed', viewed_at = v_now
            where p.id = p_proposal_id
            returning p.status, p.viewed_at into v_status, v_first_viewed_at;
        end if;
        insert into public.document_open_counts as counter
            (document_type, document_id, open_count, last_opened_at)
        values ('proposal', p_proposal_id, 1, v_now)
        on conflict (document_type, document_id) do update
            set open_count = counter.open_count + 1,
                last_opened_at = excluded.last_opened_at;
    end if;

    select c.open_count, c.last_opened_at into v_count, v_last_opened_at
    from public.document_open_counts as c
    where c.document_type = 'proposal' and c.document_id = p_proposal_id;
    return query select v_status, v_first_viewed_at, v_count, v_last_opened_at, v_first_opened;
end;
$$;

revoke all on function public.record_proposal_open(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.record_proposal_open(uuid, text, uuid) to service_role;

comment on table public.proposal_open_events is
    'Idempotency keys for displayed proposal visits. Reloads and separate visits count again. No visitor identity is inferred. Historical totals remain in document_open_counts.';

commit;
