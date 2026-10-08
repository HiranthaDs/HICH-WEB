-- Keep agreement renewal currencies aligned with invoice and agreement forms.
begin;

alter table public.agreements
    drop constraint if exists agreements_renewal_currency_check;

alter table public.agreements
    add constraint agreements_renewal_currency_check
    check (renewal_currency in ('LKR', 'USD', 'GBP'));

commit;
