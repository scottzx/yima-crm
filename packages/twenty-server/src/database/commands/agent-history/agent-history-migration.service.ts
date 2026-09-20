import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';

import { AGENT_HISTORY_TABLES } from 'src/database/commands/agent-history/agent-history-tables.constant';
import { AgentHistoryStorageService } from 'src/engine/metadata-modules/ai/ai-history/services/agent-history-storage.service';
import { AGENT_HISTORY_STORAGE_KEY } from 'src/engine/metadata-modules/ai/ai-history/constants/agent-history-storage-key.constant';
import { type AgentHistoryStorageState } from 'src/engine/metadata-modules/ai/ai-history/types/agent-history-storage-state.type';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

type Storage = AgentHistoryStorageState['storage'];
type HistoryTable = (typeof AGENT_HISTORY_TABLES)[number];

@Injectable()
export class AgentHistoryMigrationService {
  private readonly logger = new Logger(AgentHistoryMigrationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storageService: AgentHistoryStorageService,
  ) {}

  async migrate(
    workspaceId: string,
    target: Storage,
    dryRun: boolean,
    batchSize = 1000,
  ): Promise<void> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000)
      throw new Error('Batch size must be between 1 and 10000');
    const runner = this.dataSource.createQueryRunner('master');
    let ownsRunnerLock = false;
    const runnerKey = `${AGENT_HISTORY_STORAGE_KEY}:runner:${workspaceId}`;
    try {
      await runner.connect();
      const [{ acquired }]: { acquired: boolean }[] = await runner.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [runnerKey],
      );
      ownsRunnerLock = acquired;
      if (!acquired)
        throw new Error(
          'An agent history migration is already running for this workspace',
        );
      let state = await this.storageService.readState(runner, workspaceId);
      if (state.migration?.phase === 'aborting')
        throw new Error(
          'Finish aborting the incomplete migration before starting another copy',
        );
      if (state.storage === target && !state.migration) return;
      if (state.migration && state.migration.target !== target)
        throw new Error(
          'Resume the in-progress migration or abort it before changing direction',
        );
      await this.validateSchema(runner, workspaceId);
      if (dryRun) {
        await this.assertNoActiveStreams(runner, workspaceId, state.storage);
        this.logger.log(
          `[DRY RUN] ${workspaceId}: ${state.storage} -> ${target}`,
        );
        return;
      }
      if (!state.migration) {
        state = await this.fenced(runner, workspaceId, async () => {
          const current = await this.storageService.readState(
            runner,
            workspaceId,
          );
          await this.assertNoActiveStreams(
            runner,
            workspaceId,
            current.storage,
          );
          await this.validateReferences(runner, workspaceId, current.storage);
          if (target === 'core')
            await this.assertNoCoreIdCollisions(runner, workspaceId);
          const next: AgentHistoryStorageState = {
            ...current,
            migration: {
              phase: 'clearing',
              target,
              tableIndex: 0,
              lastId: null,
            },
          };
          await this.storageService.writeState(runner, workspaceId, next);
          return next;
        });
      }
      if (state.migration?.phase === 'clearing') {
        await this.clearStore(runner, workspaceId, target);
        state = await this.fenced(runner, workspaceId, async () => {
          const next: AgentHistoryStorageState = {
            ...state,
            migration: {
              phase: 'copying',
              target,
              tableIndex: 0,
              lastId: null,
            },
          };
          await this.storageService.writeState(runner, workspaceId, next);
          return next;
        });
      }
      while (
        state.migration &&
        state.migration.tableIndex < AGENT_HISTORY_TABLES.length
      ) {
        state = await this.fenced(runner, workspaceId, async () => {
          const current = await this.storageService.readState(
            runner,
            workspaceId,
          );
          const progress = current.migration;
          if (!progress || progress.target !== target)
            throw new Error('Migration state changed unexpectedly');
          const table = AGENT_HISTORY_TABLES[progress.tableIndex];
          const ids = await this.copyBatch(
            runner,
            workspaceId,
            table,
            current.storage,
            target,
            progress.lastId,
            batchSize,
          );
          const next: AgentHistoryStorageState = {
            ...current,
            migration: {
              phase: 'copying',
              target,
              tableIndex:
                ids.length < batchSize
                  ? progress.tableIndex + 1
                  : progress.tableIndex,
              lastId: ids.length < batchSize ? null : ids[ids.length - 1],
            },
          };
          await this.storageService.writeState(runner, workspaceId, next);
          this.logger.log(
            `${workspaceId}: copied ${ids.length} ${table.name} rows`,
          );
          return next;
        });
      }
      await this.fenced(runner, workspaceId, async () => {
        await this.verify(runner, workspaceId);
        await this.validateReferences(runner, workspaceId, target);
        await this.storageService.writeState(runner, workspaceId, {
          storage: target,
          verifiedAt: new Date().toISOString(),
        });
      });
      this.logger.log(`${workspaceId}: verified and switched to ${target}`);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (ownsRunnerLock)
        await runner.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [runnerKey],
        );
      await runner.release();
    }
  }

  async abort(workspaceId: string, dryRun: boolean): Promise<void> {
    const runner = this.dataSource.createQueryRunner('master');
    const key = `${AGENT_HISTORY_STORAGE_KEY}:runner:${workspaceId}`;
    let ownsLock = false;
    try {
      await runner.connect();
      const [{ acquired }]: { acquired: boolean }[] = await runner.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [key],
      );
      ownsLock = acquired;
      if (!acquired)
        throw new Error('Stop the running migration before aborting');
      const state = await this.storageService.readState(runner, workspaceId);
      if (!state.migration || dryRun) return;
      await this.fenced(runner, workspaceId, () =>
        this.storageService.writeState(runner, workspaceId, {
          ...state,
          migration: { ...state.migration!, phase: 'aborting' },
        }),
      );
      await this.clearStore(runner, workspaceId, state.migration.target);
      await this.fenced(runner, workspaceId, () =>
        this.storageService.writeState(runner, workspaceId, {
          ...state,
          migration: undefined,
        }),
      );
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (ownsLock)
        await runner.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [key],
        );
      await runner.release();
    }
  }

  async inspect(workspaceId: string): Promise<void> {
    const runner = this.dataSource.createQueryRunner('master');
    try {
      await runner.connect();
      const state = await this.storageService.readState(runner, workspaceId);
      this.logger.log(`${workspaceId}: ${JSON.stringify(state)}`);
      await this.assertNoActiveStreams(runner, workspaceId, state.storage);
      await this.validateReferences(runner, workspaceId, state.storage);
      for (const table of AGENT_HISTORY_TABLES) {
        const [{ count }] = await runner.query(
          `SELECT count(*) FROM ${this.table(workspaceId, state.storage, table.name)} ${state.storage === 'core' ? 'WHERE "workspaceId" = $1' : ''}`,
          state.storage === 'core' ? [workspaceId] : [],
        );
        this.logger.log(`${workspaceId}: ${table.name}: ${count} source rows`);
      }
    } finally {
      await runner.release();
    }
  }

  async cleanup(
    workspaceId: string,
    dryRun: boolean,
    retentionDays: number,
  ): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1)
      throw new Error('Retention must be at least one day');
    const runner = this.dataSource.createQueryRunner('master');
    const key = `${AGENT_HISTORY_STORAGE_KEY}:runner:${workspaceId}`;
    let ownsLock = false;
    try {
      await runner.connect();
      const [{ acquired }] = await runner.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [key],
      );
      ownsLock = acquired;
      if (!ownsLock) {
        this.logger.log(
          `${workspaceId}: migration runner active; skipping cleanup`,
        );
        return;
      }
      const state = await this.storageService.readState(runner, workspaceId);
      if (
        state.storage !== 'workspace' ||
        state.migration ||
        !state.verifiedAt
      ) {
        this.logger.log(`${workspaceId}: not eligible; skipping cleanup`);
        return;
      }
      if (state.cleanedAt) return;
      const verifiedAt = Date.parse(state.verifiedAt);
      if (Date.now() - verifiedAt < retentionDays * 86400000) {
        this.logger.log(
          `${workspaceId}: retention window has not elapsed; skipping cleanup`,
        );
        return;
      }
      if (dryRun) {
        this.logger.log(`[DRY RUN] ${workspaceId}: eligible for cleanup`);
        return;
      }
      // The session lock excludes rollback; live workspace traffic can continue.
      for (const table of [...AGENT_HISTORY_TABLES].reverse()) {
        let deleted: { id: string }[];
        do {
          deleted = await runner.query(
            `WITH batch AS (SELECT id FROM core.${escapeIdentifier(table.name)} WHERE "workspaceId" = $1 ORDER BY id LIMIT 1000), deleted AS (DELETE FROM core.${escapeIdentifier(table.name)} target USING batch WHERE target.id = batch.id RETURNING target.id) SELECT id FROM deleted`,
            [workspaceId],
          );
        } while (deleted.length > 0);
      }
      await this.storageService.writeState(runner, workspaceId, {
        ...state,
        cleanedAt: new Date().toISOString(),
      });
    } finally {
      if (ownsLock)
        await runner.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [key],
        );
      await runner.release();
    }
  }

  private async assertNoCoreIdCollisions(
    runner: QueryRunner,
    workspaceId: string,
  ): Promise<void> {
    for (const table of AGENT_HISTORY_TABLES) {
      const [{ collision }] = await runner.query(
        `SELECT EXISTS (SELECT 1 FROM ${this.table(workspaceId, 'workspace', table.name)} source JOIN core.${escapeIdentifier(table.name)} target USING (id) WHERE target."workspaceId" <> $1) AS collision`,
        [workspaceId],
      );
      if (collision)
        throw new Error(
          `Core ${table.name} contains IDs owned by another workspace`,
        );
    }
  }

  private async fenced<TResult>(
    runner: QueryRunner,
    workspaceId: string,
    work: () => Promise<TResult>,
  ): Promise<TResult> {
    await runner.startTransaction();
    try {
      await runner.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${AGENT_HISTORY_STORAGE_KEY}:${workspaceId}`],
      );
      const result = await work();
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  }

  private table(workspaceId: string, storage: Storage, name: string): string {
    return `${escapeIdentifier(storage === 'core' ? 'core' : getWorkspaceSchemaName(workspaceId))}.${escapeIdentifier(name)}`;
  }

  private async assertNoActiveStreams(
    runner: QueryRunner,
    workspaceId: string,
    source: Storage,
  ): Promise<void> {
    const rows: { id: string }[] = await runner.query(
      `SELECT id FROM ${this.table(workspaceId, source, 'agentChatThread')} WHERE "activeStreamId" IS NOT NULL ${source === 'core' ? 'AND "workspaceId" = $1' : ''} LIMIT 1`,
      source === 'core' ? [workspaceId] : [],
    );
    if (rows.length)
      throw new Error(
        'Agent streams are still active. Drain or cancel them before migrating',
      );
  }

  private async clearStore(
    runner: QueryRunner,
    workspaceId: string,
    storage: Storage,
  ): Promise<void> {
    for (const table of [...AGENT_HISTORY_TABLES].reverse()) {
      let rows: { id: string }[];
      do {
        rows = await runner.query(
          `WITH batch AS (SELECT id FROM ${this.table(workspaceId, storage, table.name)} ${storage === 'core' ? 'WHERE "workspaceId" = $1' : ''} ORDER BY id LIMIT 1000),
           deleted AS (DELETE FROM ${this.table(workspaceId, storage, table.name)} target USING batch WHERE target.id = batch.id RETURNING target.id)
           SELECT id FROM deleted`,
          storage === 'core' ? [workspaceId] : [],
        );
      } while (rows.length > 0);
    }
  }

  private column(table: string, storage: Storage, column: string): string {
    // Chat archive state must not enter the generic workspace trash lifecycle.
    return storage === 'workspace' &&
      table === 'agentChatThread' &&
      column === 'deletedAt'
      ? 'archivedAt'
      : column;
  }

  private async copyBatch(
    runner: QueryRunner,
    workspaceId: string,
    table: HistoryTable,
    source: Storage,
    target: Storage,
    lastId: string | null,
    batchSize: number,
  ): Promise<string[]> {
    const columns: readonly string[] = table.columns;
    const targetColumns = [
      ...columns.map((column) => this.column(table.name, target, column)),
      ...(target === 'core' ? ['workspaceId'] : []),
    ];
    const selection = columns.map((column) => {
      const quoted = escapeIdentifier(this.column(table.name, source, column));
      if (
        target === 'core' &&
        table.name === 'agentMessage' &&
        ['role', 'status'].includes(column)
      )
        return `${quoted}::text::"core".${escapeIdentifier(`agentMessage_${column}_enum`)}`;
      return table.name === 'agentMessage' &&
        ['role', 'status'].includes(column)
        ? `${quoted}::text`
        : quoted;
    });
    if (target === 'core') selection.push('$1::uuid');
    const rows: { id: string; copied: boolean }[] = await runner.query(
      `
      WITH batch AS (
        SELECT * FROM ${this.table(workspaceId, source, table.name)}
        WHERE ($2::uuid IS NULL OR id > $2) ${source === 'core' ? 'AND "workspaceId" = $1' : ''}
        ORDER BY id LIMIT $3
      ), copied AS (
        INSERT INTO ${this.table(workspaceId, target, table.name)} AS destination (${targetColumns.map(escapeIdentifier).join(', ')})
        SELECT ${selection.join(', ')} FROM batch ORDER BY id
        ON CONFLICT (id) DO UPDATE SET ${targetColumns
          .filter((column) => !['id', 'workspaceId'].includes(column))
          .map(
            (column) =>
              `${escapeIdentifier(column)} = EXCLUDED.${escapeIdentifier(column)}`,
          )
          .join(', ')}
        ${target === 'core' ? 'WHERE destination."workspaceId" = $1' : ''}
        RETURNING id
      ) SELECT batch.id, copied.id IS NOT NULL AS copied FROM batch LEFT JOIN copied USING (id) ORDER BY batch.id`,
      [workspaceId, lastId, batchSize],
    );
    const rejected = rows.find((row) => !row.copied);
    if (rejected)
      throw new Error(
        `Could not copy ${table.name} ${rejected.id}: destination ID belongs to another workspace`,
      );
    return rows.map((row) => row.id);
  }

  private async verify(
    runner: QueryRunner,
    workspaceId: string,
  ): Promise<void> {
    for (const table of AGENT_HISTORY_TABLES) {
      const columns = table.columns.map(escapeIdentifier).join(', ');
      const targetColumns = table.columns
        .map(
          (column) =>
            `${escapeIdentifier(this.column(table.name, 'workspace', column))} AS ${escapeIdentifier(column)}`,
        )
        .join(', ');
      const [{ mismatch }]: { mismatch: boolean }[] = await runner.query(
        `
        SELECT EXISTS (
          SELECT 1 FROM (SELECT ${columns} FROM core.${escapeIdentifier(table.name)} WHERE "workspaceId" = $1) source
          FULL JOIN (SELECT ${targetColumns} FROM ${this.table(workspaceId, 'workspace', table.name)}) target USING (id)
          WHERE to_jsonb(source) IS DISTINCT FROM to_jsonb(target)
        ) AS mismatch`,
        [workspaceId],
      );
      if (mismatch)
        throw new Error(
          `Agent history verification failed for ${table.name}; workspace remains fenced`,
        );
    }
  }

  private async validateSchema(
    runner: QueryRunner,
    workspaceId: string,
  ): Promise<void> {
    for (const table of AGENT_HISTORY_TABLES) {
      const rows: { column_name: string }[] = await runner.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        ['core', table.name],
      );
      const expected = new Set<string>([...table.columns, 'workspaceId']);
      if (
        rows.length !== expected.size ||
        rows.some((row) => !expected.has(row.column_name))
      )
        throw new Error(
          `Legacy ${table.name} columns have changed; update the migration before proceeding`,
        );
      const targetRows: { column_name: string }[] = await runner.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        [getWorkspaceSchemaName(workspaceId), table.name],
      );
      const targetColumns = new Set(targetRows.map((row) => row.column_name));
      if (
        table.columns.some(
          (column) =>
            !targetColumns.has(this.column(table.name, 'workspace', column)),
        )
      )
        throw new Error(`Workspace ${table.name} schema is not prepared`);
    }
  }

  private async validateReferences(
    runner: QueryRunner,
    workspaceId: string,
    storage: Storage,
  ): Promise<void> {
    for (const [child, column, parent] of [
      ['agentChatThread', 'userWorkspaceId', 'userWorkspace'],
      ['agentMessagePart', 'fileId', 'file'],
    ]) {
      const [{ invalid }] = await runner.query(
        `SELECT EXISTS (
        SELECT 1 FROM ${this.table(workspaceId, storage, child)} child
        LEFT JOIN core.${escapeIdentifier(parent)} parent ON parent.id = child.${escapeIdentifier(column)} AND parent."workspaceId" = $1
        WHERE child.${escapeIdentifier(column)} IS NOT NULL AND parent.id IS NULL ${storage === 'core' ? 'AND child."workspaceId" = $1' : ''}
      ) AS invalid`,
        [workspaceId],
      );
      if (invalid)
        throw new Error(
          `Invalid or cross-workspace ${child}.${column} reference`,
        );
    }
    const [{ inconsistentTurn }] = await runner.query(
      `SELECT EXISTS (
      SELECT 1 FROM ${this.table(workspaceId, storage, 'agentMessage')} message
      JOIN ${this.table(workspaceId, storage, 'agentTurn')} turn ON turn.id = message."turnId"
      WHERE message."threadId" IS DISTINCT FROM turn."threadId" ${storage === 'core' ? 'AND message."workspaceId" = $1' : ''}
    ) AS "inconsistentTurn"`,
      storage === 'core' ? [workspaceId] : [],
    );
    if (inconsistentTurn)
      throw new Error('A message and its turn belong to different threads');
    for (const [child, column, parent] of [
      ['agentTurn', 'threadId', 'agentChatThread'],
      ['agentMessage', 'threadId', 'agentChatThread'],
      ['agentMessage', 'turnId', 'agentTurn'],
      ['agentMessagePart', 'messageId', 'agentMessage'],
      ['agentTurnEvaluation', 'turnId', 'agentTurn'],
    ]) {
      const [{ invalid }]: { invalid: boolean }[] = await runner.query(
        `SELECT EXISTS (
        SELECT 1 FROM ${this.table(workspaceId, storage, child)} child
        LEFT JOIN ${this.table(workspaceId, storage, parent)} parent ON parent.id = child.${escapeIdentifier(column)} ${storage === 'core' ? 'AND parent."workspaceId" = $1' : ''}
        WHERE child.${escapeIdentifier(column)} IS NOT NULL AND parent.id IS NULL ${storage === 'core' ? 'AND child."workspaceId" = $1' : ''}
      ) AS invalid`,
        storage === 'core' ? [workspaceId] : [],
      );
      if (invalid)
        throw new Error(
          `Invalid or cross-workspace ${child}.${column} reference`,
        );
    }
  }
}
