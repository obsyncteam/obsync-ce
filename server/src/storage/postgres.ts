import pg from "pg";
import type { DatabaseConfig } from "../config.js";

const { Pool } = pg;

export type PostgresPool = pg.Pool;
export type PostgresClient = pg.PoolClient;

export function createPostgresPool(database: DatabaseConfig): PostgresPool {
  return new Pool({
    connectionString: database.connectionString,
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function assertPostgresReady(pool: PostgresPool): Promise<void> {
  await pool.query("select 1");
}

export async function runMigrations(pool: PostgresPool): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const lockClient = await pool.connect();
  try {
    await lockClient.query(
      "select pg_advisory_lock(hashtextextended($1, 0))",
      ["obsync:schema_migrations"],
    );

    await migrate(pool, 1, "initial_sync_schema", `
      create table if not exists vaults (
      id text primary key,
      name text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists devices (
      vault_id text not null references vaults(id) on delete cascade,
      id text not null,
      name text not null,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      primary key (vault_id, id)
    );

    create table if not exists files (
      vault_id text not null references vaults(id) on delete cascade,
      file_id text not null,
      path text not null,
      kind text not null,
      hash text,
      size_bytes bigint,
      mtime_ms bigint,
      deleted_at timestamptz,
      updated_seq bigint,
      updated_at timestamptz not null default now(),
      primary key (vault_id, file_id)
    );

    create table if not exists operations (
      server_seq bigserial primary key,
      vault_id text not null references vaults(id) on delete cascade,
      op_id text not null,
      device_id text not null,
      operation_type text not null,
      file_id text,
      path text,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      unique (vault_id, op_id)
    );

    create index if not exists operations_vault_seq_idx
      on operations(vault_id, server_seq);

    create index if not exists operations_vault_device_idx
      on operations(vault_id, device_id);

    create table if not exists tombstones (
      vault_id text not null references vaults(id) on delete cascade,
      file_id text not null,
      path text not null,
      op_id text not null,
      device_id text not null,
      deleted_seq bigint,
      deleted_at timestamptz not null default now(),
      primary key (vault_id, file_id)
    );

    create table if not exists blob_refs (
      vault_id text not null references vaults(id) on delete cascade,
      hash text not null,
      size_bytes bigint not null,
      storage_key text not null,
      storage_kind text not null,
      content_type text,
      created_at timestamptz not null default now(),
      primary key (vault_id, hash)
    );
  `);

    await migrate(pool, 2, "current_file_storage", `
    alter table files
      add column if not exists storage_key text,
      add column if not exists storage_kind text,
      add column if not exists content_type text;

    create index if not exists files_vault_path_idx
      on files(vault_id, path);
  `);

    await migrate(pool, 3, "sync_hardening_indexes", `
    create index if not exists operations_vault_file_seq_idx
      on operations(vault_id, file_id, server_seq desc);

    create index if not exists operations_vault_created_at_idx
      on operations(vault_id, created_at);

    create index if not exists files_vault_updated_seq_idx
      on files(vault_id, updated_seq);

    create index if not exists files_vault_hash_idx
      on files(vault_id, hash);

    create index if not exists tombstones_vault_deleted_seq_idx
      on tombstones(vault_id, deleted_seq);

    create index if not exists tombstones_vault_deleted_at_idx
      on tombstones(vault_id, deleted_at);
  `);

    await migrate(pool, 4, "storage_quota_ledger", `
    create table if not exists vault_quotas (
      vault_id text primary key references vaults(id) on delete cascade,
      quota_bytes bigint,
      updated_at timestamptz not null default now(),
      check (quota_bytes is null or quota_bytes >= 0)
    );

    create table if not exists quota_reservations (
      id text primary key,
      vault_id text not null references vaults(id) on delete cascade,
      source text not null,
      bytes_reserved bigint not null default 0,
      status text not null,
      expires_at timestamptz not null,
      idempotency_key text not null,
      ref_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (vault_id, idempotency_key),
      check (bytes_reserved >= 0),
      check (status in ('active', 'finalized', 'expired', 'cancelled'))
    );

    create index if not exists quota_reservations_vault_status_idx
      on quota_reservations(vault_id, status, expires_at);

    create table if not exists storage_ledger_entries (
      id bigserial primary key,
      vault_id text not null references vaults(id) on delete cascade,
      source text not null,
      delta_logical_bytes bigint not null default 0,
      delta_physical_bytes bigint not null default 0,
      delta_reserved_bytes bigint not null default 0,
      reason text not null,
      ref_id text,
      created_at timestamptz not null default now()
    );

    create index if not exists storage_ledger_entries_vault_created_idx
      on storage_ledger_entries(vault_id, created_at);

    alter table blob_refs
      add column if not exists orphaned_at timestamptz,
      add column if not exists deleted_at timestamptz;

    create index if not exists blob_refs_vault_orphaned_idx
      on blob_refs(vault_id, orphaned_at)
      where orphaned_at is not null;
  `);

    await migrate(pool, 5, "upload_session_metadata", `
    create table if not exists upload_sessions (
      id text primary key,
      vault_id text not null references vaults(id) on delete cascade,
      device_id text not null,
      file_id text not null,
      path text not null,
      kind text not null,
      size_bytes bigint not null,
      mtime_ms bigint,
      content_type text,
      expected_hash text,
      expected_current_hash text,
      expected_current_seq bigint,
      chunk_size_bytes integer not null,
      quota_reservation_id text references quota_reservations(id) on delete set null,
      status text not null,
      finalized jsonb,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (size_bytes >= 0),
      check (chunk_size_bytes > 0),
      check (status in ('uploading', 'finalizing', 'finalized'))
    );

    create index if not exists upload_sessions_status_updated_idx
      on upload_sessions(status, updated_at);

    create index if not exists upload_sessions_expires_idx
      on upload_sessions(expires_at);

    create index if not exists upload_sessions_vault_updated_idx
      on upload_sessions(vault_id, updated_at);

    create table if not exists upload_chunks (
      upload_session_id text not null references upload_sessions(id) on delete cascade,
      chunk_index integer not null,
      size_bytes bigint not null,
      hash text not null,
      received_at timestamptz not null default now(),
      primary key(upload_session_id, chunk_index),
      check (chunk_index >= 0),
      check (size_bytes >= 0)
    );
  `);

    await migrate(pool, 6, "markdown_version_history", `
    create table if not exists markdown_versions (
      vault_id text not null references vaults(id) on delete cascade,
      file_id text not null,
      path text not null,
      server_seq bigint not null,
      op_id text not null,
      device_id text not null,
      source text not null,
      hash text not null,
      size_bytes bigint not null,
      markdown text not null,
      retention_limit integer not null default 10,
      created_at timestamptz not null default now(),
      primary key (vault_id, file_id, server_seq),
      check (size_bytes >= 0),
      check (retention_limit >= 1),
      check (length(markdown) <= 1000000)
    );

    create index if not exists markdown_versions_vault_path_seq_idx
      on markdown_versions(vault_id, path, server_seq desc);

    create index if not exists markdown_versions_vault_file_seq_idx
      on markdown_versions(vault_id, file_id, server_seq desc);
  `);

    await migrate(pool, 7, "active_file_path_unique", `
    alter table files
      drop constraint if exists files_vault_id_path_key;

    create unique index if not exists files_vault_path_active_unique_idx
      on files(vault_id, path)
      where deleted_at is null;
  `);
  } finally {
    await lockClient.query(
      "select pg_advisory_unlock(hashtextextended($1, 0))",
      ["obsync:schema_migrations"],
    ).catch(() => undefined);
    lockClient.release();
  }
}

async function migrate(
  pool: PostgresPool,
  version: number,
  name: string,
  sql: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await client.query(
      "select version from schema_migrations where version = $1",
      [version],
    );

    if (existing.rowCount === 0) {
      await client.query(sql);
      await client.query(
        `
          insert into schema_migrations(version, name)
          values ($1, $2)
          on conflict (version) do nothing
        `,
        [version, name],
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
