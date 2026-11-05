// Sponsor Management API as a Supabase Edge Function.
// Same server code as on a normal computer (../_shared/core), connected to Supabase's Postgres database.
// Supabase provides SUPABASE_DB_URL automatically.
// Optional secret SP_SETUP_CODE: lets the first SAO Head account be created from the website (the form asks for the code).
import postgres from 'npm:postgres@3.4.5';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createApp } from '../_shared/core/app.mjs';

const env = (k: string) => Deno.env.get(k) || '';

// Big numbers (times) come back as normal numbers
const sql = postgres(env('SUPABASE_DB_URL'), {
  prepare: false, max: 4, idle_timeout: 20,
  types: { bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } },
});
const als = new AsyncLocalStorage();
// One change at a time (a database lock), so two clubs can never claim the same sponsor at the same moment.
// The unique index on active claims guards this as well.
const driver = {
  dialect: 'pg',
  query: (text: string, params: unknown[] = []) => ((als.getStore() as any) || sql).unsafe(text, params as any[]),
  exec: (text: string) => ((als.getStore() as any) || sql).unsafe(text),
  transaction: (fn: () => Promise<unknown>) => als.getStore()
    ? fn()
    : sql.begin(async (tx: any) => als.run(tx, async () => { await tx.unsafe('SELECT pg_advisory_xact_lock(55174)'); return fn(); })),
};

const setupCode = env('SP_SETUP_CODE');
const app = createApp({ driver, allowSetup: !!setupCode, setupCode });

Deno.serve((req: Request) => app.handle(req, { ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() }));
