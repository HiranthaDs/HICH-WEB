-- All fixtures are synthetic and the entire transaction is rolled back.
begin;
do $$
declare
    client_key uuid;
    source public.invoices;
    bill public.invoices;
    reused public.invoices;
    phase_key uuid;
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
    select * into reused from public.create_renewal_invoice(source.id, today - 7,
        fields || jsonb_build_object('invoice_number', 'TEST-RETRY-' || gen_random_uuid()), null);
    if bill.id <> reused.id then raise exception 'TEST FAILED: retry created a duplicate bill'; end if;
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

    insert into public.payments(invoice_id, amount, currency, paid_at, method, reference)
        values(bill.id, 14160, 'LKR', now(), 'Bank transfer', 'SYNTHETIC-RENEWAL-PAID');
    if (select status from public.invoices where id = bill.id) <> 'paid' then
        raise exception 'TEST FAILED: payment did not settle the renewal invoice';
    end if;
    if (select sum(amount) from public.payments where invoice_id = source.id) <> 1000 then
        raise exception 'TEST FAILED: renewal payment altered the development receipt ledger';
    end if;
    if not exists(select 1 from public.invoice_versions where invoice_id = bill.id and snapshot->'renewal_items' = charges) then
        raise exception 'TEST FAILED: service charges are absent from invoice history';
    end if;
    begin
        insert into public.payments(invoice_id, amount, currency, paid_at) values(bill.id, 1, 'LKR', now());
        raise exception 'TEST FAILED: renewal overpayment was accepted';
    exception when others then
        if sqlerrm not like '%invoice_validation:%remaining invoice balance%' then raise; end if;
    end;
end;
$$;
rollback;
