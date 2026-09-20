import { addFlatEntityToFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/add-flat-entity-to-flat-entity-maps-or-throw.util';
import { AgentHistoryLifecycleService } from 'src/engine/metadata-modules/ai/ai-history/services/agent-history-lifecycle.service';
import { Injectable } from '@nestjs/common';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { MetadataReadability, MetadataWritability } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { AGENT_HISTORY_TABLES } from 'src/database/commands/agent-history/agent-history-tables.constant';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

@Injectable()
export class AgentHistorySchemaService {
  constructor(
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly lifecycle: AgentHistoryLifecycleService,
    private readonly migrations: WorkspaceMigrationValidateBuildAndRunService,
  ) {}

  async prepare(workspaceId: string, dryRun: boolean): Promise<void> {
    const existing = await this.workspaceCacheService.getOrRecompute(
      workspaceId,
      [
        'flatObjectMetadataMaps',
        'flatFieldMetadataMaps',
        'flatIndexMaps',
        'featureFlagsMap',
      ],
    );
    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const {
      allFlatEntityMaps: standard,
      idByUniversalIdentifierByMetadataName,
    } = computeTwentyStandardApplicationAllFlatEntityMaps({
      now: new Date().toISOString(),
      workspaceId,
      twentyStandardApplicationId: twentyStandardFlatApplication.id,
    });
    const objectIdentifiers = new Set<string>(
      AGENT_HISTORY_TABLES.map(
        ({ name }) => STANDARD_OBJECTS[name].universalIdentifier,
      ),
    );
    for (const identifier of objectIdentifiers) {
      const current =
        existing.flatObjectMetadataMaps.byUniversalIdentifier[identifier];
      const expected =
        standard.flatObjectMetadataMaps.byUniversalIdentifier[identifier];
      if (
        current &&
        (current.nameSingular !== expected?.nameSingular ||
          current.readability !== MetadataReadability.SYSTEM ||
          current.writability !== MetadataWritability.SYSTEM ||
          current.isSearchable ||
          current.isAuditLogged)
      ) {
        throw new Error(
          'Agent history object protections have drifted; repair metadata before migrating',
        );
      }
    }
    const objects = Object.values(
      standard.flatObjectMetadataMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .filter(
        (object) =>
          objectIdentifiers.has(object.universalIdentifier) &&
          !existing.flatObjectMetadataMaps.byUniversalIdentifier[
            object.universalIdentifier
          ],
      );
    const fields = Object.values(
      standard.flatFieldMetadataMaps.byUniversalIdentifier,
    )
      .filter(isDefined)
      .filter(
        (field) =>
          objectIdentifiers.has(field.objectMetadataUniversalIdentifier) &&
          !existing.flatFieldMetadataMaps.byUniversalIdentifier[
            field.universalIdentifier
          ],
      );
    const indexes = Object.values(standard.flatIndexMaps.byUniversalIdentifier)
      .filter(isDefined)
      .filter(
        (index) =>
          objectIdentifiers.has(index.objectMetadataUniversalIdentifier) &&
          !existing.flatIndexMaps.byUniversalIdentifier[
            index.universalIdentifier
          ],
      );
    if (objects.length + fields.length + indexes.length === 0) {
      if (!dryRun) await this.lifecycle.prepareCoreReferences(workspaceId);
      return;
    }
    // Standard definitions use the same from/to path as standard application
    // synchronization; custom-object side effects must not expand this schema.
    const result =
      await this.migrations.validateBuildAndRunWorkspaceMigrationFromTo({
        workspaceId,
        dryRun,
        buildOptions: {
          isSystemBuild: true,
          inferDeletionFromMissingEntities: {},
          applicationUniversalIdentifier:
            twentyStandardFlatApplication.universalIdentifier,
        },
        additionalCacheDataMaps: { featureFlagsMap: existing.featureFlagsMap },
        idByUniversalIdentifierByMetadataName,
        fromToAllFlatEntityMaps: {
          flatObjectMetadataMaps: {
            from: existing.flatObjectMetadataMaps,
            to: objects.reduce(
              (maps, flatEntity) =>
                addFlatEntityToFlatEntityMapsOrThrow({
                  flatEntityMaps: maps,
                  flatEntity,
                }),
              existing.flatObjectMetadataMaps,
            ),
          },
          flatFieldMetadataMaps: {
            from: existing.flatFieldMetadataMaps,
            to: fields.reduce(
              (maps, flatEntity) =>
                addFlatEntityToFlatEntityMapsOrThrow({
                  flatEntityMaps: maps,
                  flatEntity,
                }),
              existing.flatFieldMetadataMaps,
            ),
          },
          flatIndexMaps: {
            from: existing.flatIndexMaps,
            to: indexes.reduce(
              (maps, flatEntity) =>
                addFlatEntityToFlatEntityMapsOrThrow({
                  flatEntityMaps: maps,
                  flatEntity,
                }),
              existing.flatIndexMaps,
            ),
          },
        },
      });
    if (result.status === 'fail')
      throw new Error(
        `Agent history schema validation failed: ${JSON.stringify(result)}`,
      );
    if (!dryRun) await this.lifecycle.prepareCoreReferences(workspaceId);
  }
}
