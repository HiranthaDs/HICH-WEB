-- Deleted bills must not block a replacement, and a charge correction that
-- settles a renewal must advance the source cycle just like a new receipt.
begin;

drop index if exists public.renewal_invoice_cycle_unique;
create unique index renewal_invoice_cycle_unique
    on public.invoices(renewal_source_invoice_id, renewal_period_date)
    where invoice_kind = 'renewal' and status <> 'void' and deleted_at is null;

create or replace function public.advance_paid_renewal_cycle()
returns trigger language plpgsql set search_path = public as $$
begin
    if new.deleted_at is null
       and new.renewal_source_invoice_id is not null
       and new.renewal_period_date is not null
       and coalesce((select sum(amount) from public.payments where invoice_id = new.id), 0) >= new.project_value then
        update public.invoices
        set renewal_due_date = (new.renewal_period_date + interval '1 year')::date
        where id = new.renewal_source_invoice_id
          and invoice_kind = 'project'
          and status <> 'void'
          and deleted_at is null
          and renewal_due_date = new.renewal_period_date;
    end if;
    return new;
end;
$$;

create trigger advance_paid_renewal_cycle_after_update
after update of project_value, status on public.invoices
for each row
when (new.invoice_kind = 'renewal' and new.status = 'paid'
      and (old.status is distinct from new.status or old.project_value is distinct from new.project_value))
execute function public.advance_paid_renewal_cycle();

-- Repair completed cycles whose total was corrected after their last receipt.
-- Preserve a source date that the operator already moved to a different cycle.
update public.invoices source
set renewal_due_date = (bill.renewal_period_date + interval '1 year')::date
from public.invoices bill
where bill.invoice_kind = 'renewal'
  and bill.status = 'paid'
  and bill.deleted_at is null
  and bill.renewal_source_invoice_id = source.id
  and source.invoice_kind = 'project'
  and source.status <> 'void'
  and source.deleted_at is null
  and source.renewal_due_date = bill.renewal_period_date
  and coalesce((select sum(p.amount) from public.payments p where p.invoice_id = bill.id), 0) >= bill.project_value;

commit;
