/* In-memory PostgreSQL regression checks. No connection to a live Supabase project.
   Install optional runner: npm install --no-save --package-lock=false @electric-sql/pglite */
const { PGlite } = require('@electric-sql/pglite');
const { citext } = require('@electric-sql/pglite/contrib/citext');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

(async () => {
  const db = new PGlite({ extensions: { citext } });
  try {
    // Supabase-managed auth/storage objects are represented locally; all portal
    // schemas, constraints, triggers and RPCs come from the actual migrations.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema storage;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.role() returns text language sql as 'select ''service_role''::text';
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text);
    `);
    const directory = path.resolve(__dirname, '../supabase/migrations');
    const migrations = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    const apply = async name => {
      // gen_random_uuid is built into PostgreSQL. This portal does not otherwise
      // use pgcrypto; the extension itself is unavailable in the WASM runner.
      const sql = fs.readFileSync(path.join(directory, name), 'utf8').replace('create extension if not exists pgcrypto;', '');
      await db.exec(sql);
    };
    for (const name of migrations.filter(name => name < '20261011')) await apply(name);
    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const client = (await one("insert into clients(name) values ('Migration test') returning id")).id;
    const otherClient = (await one("insert into clients(name) values ('Other client') returning id")).id;
    const project = (await one("insert into invoices(invoice_number,client_id,project_value,status,renewal_amount,renewal_currency,renewal_due_date) values ('INV-MIGRATION',$1,1000,'sent',120,'LKR','2026-10-11') returning id", [client])).id;
    const oldVoid = (await one("insert into invoices(invoice_number,client_id,project_value,status) values ('INV-VOID',$1,1000,'sent') returning id", [client])).id;
    const oldReceipt = (await one("insert into payments(invoice_id,amount,currency,paid_at,date_confirmed) values ($1,100,'LKR',now(),false) returning id", [oldVoid])).id;
    await db.query("update invoices set status='void' where id=$1", [oldVoid]);
    const oldRevision = (await one('select revision from invoices where id=$1', [oldVoid])).revision;
    for (const name of migrations.filter(name => name >= '20261011')) await apply(name);
    await db.exec(fs.readFileSync(path.resolve(__dirname, '../supabase/tests/renewal_invoices.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.resolve(__dirname, '../supabase/tests/proposal_opens.sql'), 'utf8'));
    const migrated = await one('select * from payments where id=$1', [oldReceipt]);
    assert.match(migrated.receipt_number, /^RCT-\d{8,}$/);
    assert.equal(migrated.date_confirmed, false);
    assert.equal((await one('select revision from invoices where id=$1', [oldVoid])).revision, oldRevision);
    const phases = (await db.query("insert into invoice_milestones(invoice_id,title,amount,position) values ($1,'Advance',500,0),($1,'Final',500,1) returning id", [project])).rows;
    const fields = { idempotency_key: randomUUID(), milestone_id: phases[0].id, amount: '200', currency: 'LKR', method: 'Bank transfer', reference: 'TEST', paid_at: new Date().toISOString() };
    const record = async data => one('select * from record_invoice_payment($1,$2::jsonb,null)', [project, JSON.stringify(data)]);
    const first = await record(fields);
    const retry = await record(fields);
    assert.equal(first.id, retry.id);
    assert.equal(first.receipt_number, retry.receipt_number);
    assert.equal((await one('select count(*)::int as count from payments where invoice_id=$1', [project])).count, 1);
    await assert.rejects(record({ ...fields, amount: '201' }), /retry key/);
    await assert.rejects(record({ ...fields, idempotency_key: randomUUID(), amount: '900' }), /remaining invoice balance/);
    await assert.rejects(record({ ...fields, idempotency_key: randomUUID(), milestone_id: null }), /choose a payment milestone/);
    await assert.rejects(db.query('update invoices set client_id=$1 where id=$2', [otherClient, project]), /cannot move/);
    await assert.rejects(db.query('delete from invoice_milestones where id=$1', [phases[0].id]), /foreign key/);
    await db.query('update payments set amount=500 where id=$1', [first.id]);
    assert.equal((await one('select status from invoice_milestones where id=$1', [phases[0].id])).status, 'paid');
    await db.query('update payments set milestone_id=$1 where id=$2', [phases[1].id, first.id]);
    assert.equal((await one('select status from invoice_milestones where id=$1', [phases[0].id])).status, 'invoiced');
    assert.equal((await one('select status from invoice_milestones where id=$1', [phases[1].id])).status, 'paid');
    const renewal = (await one(`insert into invoices(invoice_number,client_id,project_value,status,invoice_kind,renewal_source_invoice_id,renewal_period_date,renewal_items)
      values ('REN-MIGRATION',$1,120,'sent','renewal',$2,'2026-10-11','[{"service":"hosting","description":"Annual hosting","amount":120}]') returning id`, [client, project])).id;
    const renewalFields = { idempotency_key: randomUUID(), amount: '120', currency: 'LKR', paid_at: new Date().toISOString() };
    const renewalReceipt = await one('select * from record_invoice_payment($1,$2::jsonb,null)', [renewal, JSON.stringify(renewalFields)]);
    assert.equal((await one('select renewal_due_date::text from invoices where id=$1', [project])).renewal_due_date, '2027-10-11');
    await one('select * from record_invoice_payment($1,$2::jsonb,null)', [renewal, JSON.stringify(renewalFields)]);
    assert.equal((await one('select renewal_due_date::text from invoices where id=$1', [project])).renewal_due_date, '2027-10-11');
    await db.query('delete from payments where id=$1', [renewalReceipt.id]);
    assert.equal((await one('select renewal_due_date::text from invoices where id=$1', [project])).renewal_due_date, '2027-10-11');
    const nonce = randomUUID(), hash = 'a'.repeat(64);
    const published = await one("select * from publish_invoice_link($1,$2,$3,false,'2000-01-01',true)", [project, nonce, hash]);
    assert.equal(published.share_expires_at, null);
    const copied = await one('select * from publish_invoice_link($1,$2,$3,false)', [project, randomUUID(), 'b'.repeat(64)]);
    assert.equal(copied.share_nonce, nonce);
    const rotated = await one('select * from publish_invoice_link($1,$2,$3,true)', [project, randomUUID(), 'c'.repeat(64)]);
    assert.equal(rotated.share_token_hash, 'c'.repeat(64));
    console.log('PASS: all migrations; proposal open counts and retry deduplication; renewal draft preparation, cycle reuse and publication; retained void receipts; retry deduplication; overpayment; milestone ownership; receipt moves; annual renewal advancement; permanent publication and rotation.');
  } finally { await db.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
