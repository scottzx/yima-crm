import { type AgentHistoryObjectName } from 'src/engine/metadata-modules/ai/ai-history/types/agent-history-object-name.type';
import {
  type EntityTarget,
  type FindManyOptions,
  type FindOneOptions,
  type FindOptionsWhere,
  type ObjectLiteral,
  In,
} from 'typeorm';
import { type QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { isDefined } from 'twenty-shared/utils';

import {
  type AgentHistoryStorageService,
  type AgentHistoryStorageContext,
} from 'src/engine/metadata-modules/ai/ai-history/services/agent-history-storage.service';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace-repository';
import {
  type WorkspaceFindOptions,
  normalizeFindOptionsRelations,
} from 'src/engine/twenty-orm/query-builder/utils/apply-find-options.util';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { WorkspaceScopedRepository } from 'src/engine/twenty-orm/workspace-scoped-repository/workspace-scoped-repository';
import { FileEntity } from 'src/engine/core-modules/file/entities/file.entity';

export class AgentHistoryRepository<
  TRecord extends { id: string; workspaceId: string },
> {
  constructor(
    private readonly name: AgentHistoryObjectName,
    private readonly legacyEntity: EntityTarget<TRecord>,
    private readonly storageService: AgentHistoryStorageService,
    private readonly workspaceOrmManager: Pick<
      WorkspaceOrmManager,
      'executeInWorkspaceContext' | 'getRepository'
    >,
  ) {}

  private run<TResult>(
    workspaceId: string,
    core: (repository: WorkspaceScopedRepository<TRecord>) => Promise<TResult>,
    workspace: (
      repository: WorkspaceRepository<TRecord>,
      context: AgentHistoryStorageContext,
    ) => Promise<TResult>,
  ): Promise<TResult> {
    // Load metadata before reserving a core connection: a cold cache may itself
    // need the core pool. Holding every pool slot here would deadlock startup.
    // WorkspaceDataSourceService owns a separate pg pool. Keep the fence until
    // its write commits; the core transaction contains only coordination reads.
    // A later core COMMIT failure does not roll back an already committed write.
    return this.workspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.storageService.run(workspaceId, (context) => {
          if (context.storage === 'core') {
            return core(
              new WorkspaceScopedRepository(
                context.manager.getRepository(this.legacyEntity),
              ),
            );
          }
          return workspace(
            this.workspaceOrmManager.getRepository<TRecord>(
              this.name,
              { shouldBypassPermissionChecks: true },
              { shouldSkipEventEmission: true },
            ),
            context,
          );
        }),
      buildSystemAuthContext(workspaceId),
      { lite: true },
    );
  }

  async find(
    workspaceId: string,
    options?: FindManyOptions<TRecord>,
  ): Promise<TRecord[]> {
    return this.run(
      workspaceId,
      (repository) => repository.find(workspaceId, options),
      async (repository, context) => {
        const relations = normalizeFindOptionsRelations(
          (options?.relations ?? {}) as WorkspaceFindOptions['relations'] & {},
        );
        const removeFileRelation = (
          value: typeof relations,
        ): typeof relations =>
          Object.fromEntries(
            Object.entries(value)
              .filter(([name]) => name !== 'file')
              .map(([name, nested]) => [
                name,
                typeof nested === 'object'
                  ? removeFileRelation(nested)
                  : nested,
              ]),
          );
        const records = await repository.find({
          ...options,
          where: this.workspaceWhere(options?.where),
          withDeleted: true,
          relations: removeFileRelation(relations),
        } as WorkspaceFindOptions);
        const normalized = records.map((record) =>
          this.normalizeRecord(record as ObjectLiteral, workspaceId),
        );
        if (JSON.stringify(relations).includes('"file"')) {
          const parts: ObjectLiteral[] = [];
          const collectParts = (record: ObjectLiteral) => {
            if ('fileId' in record) parts.push(record);
            for (const relation of [
              'parts',
              'messages',
              'turns',
              'evaluations',
            ]) {
              if (Array.isArray(record[relation]))
                record[relation].forEach(collectParts);
            }
          };
          normalized.forEach(collectParts);
          const fileIds = [
            ...new Set(
              parts
                .map((part) => part.fileId as string | null)
                .filter(isDefined),
            ),
          ];
          const files = fileIds.length
            ? await context.manager
                .getRepository(FileEntity)
                .find({ where: { id: In(fileIds), workspaceId } })
            : [];
          const filesById = new Map(files.map((file) => [file.id, file]));
          for (const part of parts)
            part.file = filesById.get(part.fileId) ?? null;
        }
        return normalized as TRecord[];
      },
    );
  }

  async findOne(
    workspaceId: string,
    options: FindOneOptions<TRecord>,
  ): Promise<TRecord | null> {
    return (await this.find(workspaceId, { ...options, take: 1 }))[0] ?? null;
  }

  async findOneOrFail(
    workspaceId: string,
    options: FindOneOptions<TRecord>,
  ): Promise<TRecord> {
    const record = await this.findOne(workspaceId, options);
    if (!isDefined(record)) throw new Error(`${this.name} not found`);
    return record;
  }

  count(
    workspaceId: string,
    options?: FindManyOptions<TRecord>,
  ): Promise<number> {
    return this.run(
      workspaceId,
      (repository) => repository.count(workspaceId, options),
      (repository) =>
        repository.count({
          ...options,
          where: this.workspaceWhere(options?.where),
          withDeleted: true,
        } as WorkspaceFindOptions),
    );
  }

  existsBy(
    workspaceId: string,
    where: FindOptionsWhere<TRecord>,
  ): Promise<boolean> {
    return this.run(
      workspaceId,
      (repository) => repository.existsBy(workspaceId, where),
      (repository) =>
        repository.exists({
          where: this.workspaceWhere(where),
          withDeleted: true,
        }),
    );
  }

  insert(
    workspaceId: string,
    values: QueryDeepPartialEntity<TRecord> | QueryDeepPartialEntity<TRecord>[],
  ) {
    return this.run(
      workspaceId,
      (repository) => repository.insert(workspaceId, values),
      (repository) => repository.insert(this.workspaceValues(values)),
    );
  }

  insertAndReturnOne(
    workspaceId: string,
    values: QueryDeepPartialEntity<TRecord>,
  ): Promise<TRecord> {
    return this.run(
      workspaceId,
      (repository) => repository.insertAndReturnOne(workspaceId, values),
      async (repository) => {
        const result = await repository.insert(this.workspaceValues(values));
        return this.normalizeRecord(result.raw[0], workspaceId) as TRecord;
      },
    );
  }

  update(
    workspaceId: string,
    where: FindOptionsWhere<TRecord>,
    values: QueryDeepPartialEntity<TRecord>,
  ) {
    return this.run(
      workspaceId,
      (repository) => repository.update(workspaceId, where, values),
      async (repository) => {
        const result = await repository
          .createQueryBuilder()
          .withDeleted()
          .where(this.workspaceWhere(where) ?? {})
          .update()
          .set(this.workspaceValues(values) as ObjectLiteral)
          .returning(['id'])
          .execute();
        return {
          affected: result.generatedMaps.length,
          generatedMaps: result.generatedMaps,
          raw: result.generatedMaps,
        };
      },
    );
  }

  delete(workspaceId: string, where: FindOptionsWhere<TRecord>) {
    return this.run(
      workspaceId,
      (repository) => repository.delete(workspaceId, where),
      async (repository) => {
        const result = await repository
          .createQueryBuilder()
          .withDeleted()
          .where(this.workspaceWhere(where) ?? {})
          .delete()
          .returning(['id'])
          .execute();
        return {
          affected: result.generatedMaps.length,
          generatedMaps: result.generatedMaps,
          raw: result.generatedMaps,
        };
      },
    );
  }

  upsert(
    workspaceId: string,
    values: QueryDeepPartialEntity<TRecord>,
    conflictPaths: string[],
  ) {
    return this.run(
      workspaceId,
      (repository) => repository.upsert(workspaceId, values, conflictPaths),
      async (repository, context) => {
        // Workspace upsert selects before inserting. Serialize concurrent stream
        // checkpoints for the same identity to preserve core ON CONFLICT behavior.
        const identity = [...conflictPaths]
          .sort()
          .map((field) => [field, (values as ObjectLiteral)[field]]);
        await context.manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [
            `agent-history-upsert:${workspaceId}:${this.name}:${JSON.stringify(identity)}`,
          ],
        );
        return repository.upsert(this.workspaceValues(values), conflictPaths);
      },
    );
  }

  query<TResult>(
    workspaceId: string,
    work: (context: AgentHistoryStorageContext) => Promise<TResult>,
  ): Promise<TResult> {
    return this.storageService.run(workspaceId, work);
  }

  private workspaceValues(
    values: QueryDeepPartialEntity<TRecord> | QueryDeepPartialEntity<TRecord>[],
  ): ObjectLiteral | ObjectLiteral[] {
    if (Array.isArray(values))
      return values.map(
        (value) => this.workspaceValues(value) as ObjectLiteral,
      );
    const { workspaceId: _workspaceId, ...fields } = values as ObjectLiteral;
    if (this.name === 'agentChatThread' && 'deletedAt' in fields) {
      fields.archivedAt = fields.deletedAt;
      delete fields.deletedAt;
    }
    return fields;
  }

  private workspaceWhere(where: FindOptionsWhere<TRecord>): ObjectLiteral;
  private workspaceWhere(
    where: FindManyOptions<TRecord>['where'],
  ): WorkspaceFindOptions['where'];
  private workspaceWhere(
    where: FindManyOptions<TRecord>['where'],
  ): WorkspaceFindOptions['where'] {
    if (!where) return undefined;
    if (Array.isArray(where))
      return where.map((clause) =>
        this.workspaceWhere(clause),
      ) as WorkspaceFindOptions['where'];
    if ('workspaceId' in where)
      throw new Error(
        'Pass workspaceId separately from history query criteria',
      );
    if (this.name !== 'agentChatThread' || !('deletedAt' in where))
      return where;
    const { deletedAt, ...rest } = where as ObjectLiteral;
    return { ...rest, archivedAt: deletedAt };
  }

  private normalizeRecord(
    record: ObjectLiteral,
    workspaceId: string,
  ): ObjectLiteral {
    const normalized: ObjectLiteral = { ...record, workspaceId };
    if (this.name === 'agentChatThread')
      normalized.deletedAt = record.archivedAt ?? null;
    for (const field of [
      'createdAt',
      'updatedAt',
      'deletedAt',
      'processedAt',
    ]) {
      if (typeof normalized[field] === 'string')
        normalized[field] = new Date(normalized[field]);
    }
    // Existing GraphQL DTOs use numbers; durable totals are incremented in SQL.
    for (const field of [
      'totalInputCredits',
      'totalOutputCredits',
      'totalCacheReadTokens',
      'totalCacheCreationTokens',
    ]) {
      if (typeof normalized[field] === 'string')
        normalized[field] = Number(normalized[field]);
    }
    for (const field of ['parts', 'messages', 'turns', 'evaluations']) {
      if (Array.isArray(normalized[field]))
        normalized[field] = normalized[field].map((child: ObjectLiteral) =>
          this.normalizeRecord(child, workspaceId),
        );
    }
    return normalized;
  }
}
