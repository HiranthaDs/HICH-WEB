-- All fixtures are synthetic and the entire transaction is rolled back.
begin;
do $$
declare
    client_key uuid;
    source public.invoices;
    bill public.invoices;
    reused public.invoices;
    phase_key uuid;
    renewal_phase_key uuid;
    today date := (now() at time zone 'Asia/Colombo')::date;
    charges jsonb := '[{"service":"domain","description":"example.test domain renewal","amount":4000},{"service":"hosting","description":"Synthetic hosting renewal","amount":8000}]';
    fields jsonb;
begin
    insert into public.clients(name) values ('Synthetic renewal transaction test') returning id into client_key;
    select * into source from public.save_invoice_document(null,
        jsonb_build_object('invoice_number', 'TEST-PROJECT-' || gen_random_uuid(), 'client_id', client_key,
            'project_title', 'Synthetic website', 'project_value', 10000, 'currency', 'GBP',
            'issue_date', today, 'status', 'sent', 'renewal_amount', 12000,
            'renewal_currency', 'LKR', 'renewal_due_date', today - 7),
        '[{"name":"Advance","amount":2000},{"name":"Design","amount":2000},{"name":"Development","amount":2000},{"name":"Testing","amount":2000},{"name":"Final","amount":2000}]', null, null, null);
    if (select count(*) from public.invoice_milestones where invoice_id = source.id) <> 5 then
        raise exception 'TEST FAILED: five payment phases were not saved';
    end if;
    select id into phase_key from public.invoice_milestones where invoice_id = source.id and title = 'Design';
    insert into public.payments(invoice_id, milestone_id, amount, currency, paid_at, reference)
        values(source.id, phase_key, 1000, 'GBP', now(), 'SYNTHETIC-PARTIAL');

    fields := jsonb_build_object('invoice_number', 'TEST-RENEWAL-' || gen_random_uuid(),
        'project_title', 'Synthetic domain and hosting renewal', 'project_value', 14160, 'currency', 'LKR',
        'issue_date', today, 'due_date', today, 'renewal_items', charges,
        'renewal_late_fee', 2160, 'renewal_late_fee_accepted', true);
    select * into bill from public.create_renewal_invoice(source.id, today - 7, fields, null);
    if bill.status <> 'draft' or bill.share_active then
        raise exception 'TEST FAILED: preparing a renewal marked it sent before publishing';
    end if;
    -- Reopening the previous cycle remains safe after next year's date is saved.
    update public.invoices set renewal_due_date = today + 358 where id = source.id;
    select * into reused from public.create_renewal_invoice(source.id, today - 7,
        fields || jsonb_build_object('invoice_number', 'TEST-RETRY-' || gen_random_uuid()), null);
    if bill.id <> reused.id then raise exception 'TEST FAILED: retry created a duplicate bill'; end if;
    update public.invoices set renewal_due_date = today - 7 where id = source.id;
    perform public.publish_invoice_link(bill.id, gen_random_uuid(), repeat('a', 64));
    if (select status from public.invoices where id = bill.id) <> 'sent' then
        raise exception 'TEST FAILED: publishing did not mark the prepared renewal as sent';
    end if;
    if bill.client_id <> client_key or bill.invoice_kind <> 'renewal' or bill.project_value <> 14160 or bill.currency <> 'LKR' then
        raise exception 'TEST FAILED: renewal bill copied the wrong financial values';
    end if;
    if (select count(*) from public.payments where invoice_id = bill.id) <> 0 then
        raise exception 'TEST FAILED: project receipts appeared on the renewal bill';
    end if;

    begin
        update public.invoices set renewal_late_fee_accepted = false where id = bill.id;
        raise exception 'TEST FAILED: unaccepted surcharge was permitted';
    exception when others then
        if sqlerrm not like '%invoice_validation:%accepted 18%' then raise; end if;
    end;
    begin
        update public.invoices set project_value = 9999 where id = bill.id;
        raise exception 'TEST FAILED: incorrect service total was permitted';
    exception when others then
        if sqlerrm not like '%invoice_validation:%add up%' then raise; end if;
    end;
    begin
        update public.invoices set renewal_period_date = today where id = bill.id;
        raise exception 'TEST FAILED: immutable renewal cycle was changed';
    exception when others then
        if sqlerrm not like '%invoice_validation:%cannot change%' then raise; end if;
    end;

    select id into renewal_phase_key from public.invoice_milestones where invoice_id = bill.id;
    insert into public.payments(invoice_id, milestone_id, amount, currency, paid_at, method, reference)
        values(bill.id, renewal_phase_key, 14160, 'LKR', now(), 'Bank transfer', 'SYNTHETIC-RENEWAL-PAID');
    if (select status from public.invoices where id = bill.id) <> 'paid' then
        raise exception 'TEST FAILED: payment did not settle the renewal invoice';
    end if;
    if (select sum(amount) from public.payments where invoice_id = source.id) <> 1000 then
        raise exception 'TEST FAILED: renewal payment altered the development receipt ledger';
    end if;
    if (select renewal_due_date from public.invoices where id = source.id) <> ((today - 7) + interval '1 year')::date then
        raise exception 'TEST FAILED: paid renewal did not advance the source cycle';
    end if;
    select * into reused from public.create_renewal_invoice(source.id, today - 7, fields, null);
    if reused.id <> bill.id or reused.status <> 'paid' then
        raise exception 'TEST FAILED: reopening a paid prior cycle did not reuse its invoice';
    end if;
    if not exists(select 1 from public.invoice_versions where invoice_id = bill.id and snapshot->'renewal_items' = charges) then
        raise exception 'TEST FAILED: service charges are absent from invoice history';
    end if;
    begin
        insert into public.payments(invoice_id, milestone_id, amount, currency, paid_at) values(bill.id, renewal_phase_key, 1, 'LKR', now());
        raise exception 'TEST FAILED: renewal overpayment was accepted';
    exception when others then
        if sqlerrm not like '%invoice_validation:%remaining invoice balance%' then raise; end if;
    end;
    update public.invoices set deleted_at = now() where id = source.id;
    begin
        perform public.create_renewal_invoice(source.id, today - 7, fields, null);
        raise exception 'TEST FAILED: deleted source invoice was accepted';
    exception when others then
        if sqlerrm <> 'invoice_not_found' then raise; end if;
    end;
end;
$$;

do $$
declare
    client_key uuid;
    source public.invoices;
    bill public.invoices;
    replacement public.invoices;
    phase_key uuid;
    cycle date := (now() at time zone 'Asia/Colombo')::date;
    next_cycle date;
    fields jsonb;
begin
    insert into public.clients(name) values ('Synthetic corrected renewal test') returning id into client_key;
    select * into source from public.save_invoice_document(null,
        jsonb_build_object('invoice_number', 'TEST-CORRECTED-PROJECT-' || gen_random_uuid(),
            'client_id', client_key, 'project_value', 1000, 'currency', 'LKR',
            'issue_date', cycle, 'status', 'sent', 'renewal_amount', 100,
            'renewal_currency', 'LKR', 'renewal_due_date', cycle), null, null, null, null);
    fields := jsonb_build_object('invoice_number', 'TEST-CORRECTED-RENEWAL-' || gen_random_uuid(),
        'project_value', 100, 'currency', 'LKR', 'issue_date', cycle, 'due_date', cycle,
        'renewal_items', '[{"service":"hosting","description":"Synthetic hosting","amount":100}]'::jsonb);
    select * into bill from public.create_renewal_invoice(source.id, cycle, fields, null);
    select id into phase_key from public.invoice_milestones where invoice_id = bill.id;
    insert into public.payments(invoice_id, milestone_id, amount, currency, paid_at)
        values (bill.id, phase_key, 75, 'LKR', now());
    if (select status from public.invoices where id = bill.id) <> 'partial'
       or (select share_active from public.invoices where id = bill.id) then
        raise exception 'TEST FAILED: recording a draft payment lost its status or published the link';
    end if;
    if (select renewal_due_date from public.invoices where id = source.id) <> cycle then
        raise exception 'TEST FAILED: partial payment advanced the source cycle';
    end if;

    -- A service credit can settle an invoice without writing another receipt.
    select * into bill from public.save_invoice_document(bill.id,
        jsonb_build_object('project_value', 75, 'renewal_items',
            '[{"service":"hosting","description":"Hosting after service credit","amount":75}]'::jsonb),
        jsonb_build_array(jsonb_build_object('id', phase_key, 'name', 'Renewal payment', 'amount', 75)),
        null, null, null);
    next_cycle := (cycle + interval '1 year')::date;
    if bill.status <> 'paid' or (select renewal_due_date from public.invoices where id = source.id) <> next_cycle then
        raise exception 'TEST FAILED: corrected fully paid renewal did not advance the source cycle';
    end if;
    if (select count(*) from public.payments where invoice_id = bill.id) <> 1
       or (select sum(amount) from public.payments where invoice_id = bill.id) <> 75 then
        raise exception 'TEST FAILED: correcting renewal charges changed receipt history';
    end if;

    fields := fields || jsonb_build_object('invoice_number', 'TEST-DELETED-RENEWAL-' || gen_random_uuid());
    select * into bill from public.create_renewal_invoice(source.id, next_cycle, fields, null);
    update public.invoices set deleted_at = now() where id = bill.id;
    select * into replacement from public.create_renewal_invoice(source.id, next_cycle,
        fields || jsonb_build_object('invoice_number', 'TEST-REPLACEMENT-' || gen_random_uuid()), null);
    if replacement.id = bill.id or replacement.status <> 'draft' then
        raise exception 'TEST FAILED: a deleted renewal prevented preparing its replacement';
    end if;
    if not exists(select 1 from public.invoices where id = bill.id and deleted_at is not null) then
        raise exception 'TEST FAILED: replacement removed the deleted invoice history';
    end if;
end;
$$;
rollback;
