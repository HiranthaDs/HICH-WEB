-- Synthetic fixtures only; leave no data behind.
begin;
do $$
declare
    v_client uuid;
    v_proposal uuid;
    v_opening uuid := gen_random_uuid();
    v_hash text := repeat('b', 64);
    v_result record;
    v_first_view timestamptz;
begin
    insert into public.clients(name) values ('Synthetic proposal count test') returning id into v_client;
    insert into public.proposals(client_id, client_name, reference, title, html_content, content_sha256,
        status, access_token_hash, share_nonce)
    values(v_client, 'Synthetic client', 'PROP-TEST-' || gen_random_uuid(), 'Test proposal',
        '<html><body>Proposal fixture</body></html>', repeat('a', 64), 'sent', v_hash, gen_random_uuid())
    returning id into v_proposal;

    -- Retain counts recorded by older releases.
    insert into public.document_open_counts(document_type, document_id, open_count)
    values ('proposal', v_proposal, 7);
    select * into v_result from public.record_proposal_open(v_proposal, v_hash, v_opening);
    if v_result.view_count <> 8 or not v_result.first_opened or v_result.document_status <> 'viewed' then
        raise exception 'TEST FAILED: displayed open did not preserve history and mark viewed';
    end if;
    v_first_view := v_result.first_viewed_at;

    select * into v_result from public.record_proposal_open(v_proposal, v_hash, v_opening);
    if v_result.view_count <> 8 or v_result.first_opened then
        raise exception 'TEST FAILED: retried opening counted twice';
    end if;
    select * into v_result from public.record_proposal_open(v_proposal, v_hash, gen_random_uuid());
    if v_result.view_count <> 9 or v_result.first_viewed_at <> v_first_view then
        raise exception 'TEST FAILED: revisit not counted or first view overwritten';
    end if;

    update public.proposals set access_token_hash = repeat('c', 64) where id = v_proposal;
    if exists(select * from public.record_proposal_open(v_proposal, v_hash, v_opening)) then
        raise exception 'TEST FAILED: revoked token accepted on retry';
    end if;
    if exists(select * from public.record_proposal_open(v_proposal, v_hash, gen_random_uuid())) then
        raise exception 'TEST FAILED: revoked token counted';
    end if;
    update public.proposals set deleted_at = now() where id = v_proposal;
    if exists(select * from public.record_proposal_open(v_proposal, repeat('c', 64), gen_random_uuid())) then
        raise exception 'TEST FAILED: deleted proposal counted';
    end if;
    if (select open_count from public.document_open_counts where document_type='proposal' and document_id=v_proposal) <> 9
       or (select count(*) from public.proposal_open_events where proposal_id=v_proposal) <> 2 then
        raise exception 'TEST FAILED: invalid opens changed analytics';
    end if;
    if has_function_privilege('anon', 'public.record_proposal_open(uuid,text,uuid)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.record_proposal_open(uuid,text,uuid)', 'EXECUTE')
       or has_table_privilege('anon', 'public.proposal_open_events', 'SELECT') then
        raise exception 'TEST FAILED: open tracking is exposed outside the service API';
    end if;
end;
$$;
rollback;
