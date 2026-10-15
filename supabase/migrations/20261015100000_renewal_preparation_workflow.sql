-- A prepared renewal stays a draft until its client link is published.
-- Retries reuse an existing cycle, even after the source advances to next year.
begin;

create or replace function public.create_renewal_invoice(
    p_source_id uuid, p_period_date date, p_fields jsonb, p_actor_id uuid
) returns setof public.invoices language plpgsql security definer set search_path = public as $$
declare
    source public.invoices;
    existing public.invoices;
    total numeric;
begin
    select * into source from public.invoices where id = p_source_id for update;
    if not found or source.deleted_at is not null then raise exception 'invoice_not_found'; end if;
    select * into existing from public.invoices
        where renewal_source_invoice_id = p_source_id and renewal_period_date = p_period_date
            and invoice_kind = 'renewal' and status <> 'void' and deleted_at is null;
    if found then
        return next existing;
        return;
    end if;
    if source.invoice_kind <> 'project' or source.status = 'void' then
        raise exception 'invoice_validation: choose an active project invoice as the renewal source';
    end if;
    if source.renewal_due_date is distinct from p_period_date then
        raise exception 'invoice_validation: reload the source invoice because its renewal date changed';
    end if;
    total := (p_fields->>'project_value')::numeric;
    return query select * from public.save_invoice_document(null,
        p_fields || jsonb_build_object('invoice_kind', 'renewal', 'client_id', source.client_id,
            'renewal_source_invoice_id', source.id, 'renewal_period_date', p_period_date,
            'agreement_id', source.agreement_id, 'status', 'draft'),
        jsonb_build_array(jsonb_build_object('name', 'Renewal payment', 'amount', total, 'is_paid', false)),
        null, p_actor_id, null);
end;
$$;

revoke all on function public.create_renewal_invoice(uuid, date, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_renewal_invoice(uuid, date, jsonb, uuid) to service_role;

commit;
