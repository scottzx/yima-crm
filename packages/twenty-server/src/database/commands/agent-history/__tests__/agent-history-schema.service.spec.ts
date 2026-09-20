import { Test } from '@nestjs/testing';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { MetadataReadability } from 'twenty-shared/types';

import { AgentHistorySchemaService } from 'src/database/commands/agent-history/agent-history-schema.service';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { AgentHistoryLifecycleService } from 'src/engine/metadata-modules/ai/ai-history/services/agent-history-lifecycle.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';
import { createEmptyFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-flat-entity-maps.constant';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const APPLICATION_ID = '20202020-2222-4222-8222-222222222222';

describe('AgentHistorySchemaService', () => {
  const getOrRecompute = jest.fn();
  const migrate = jest.fn().mockResolvedValue({ status: 'success' });
  const prepareCoreReferences = jest.fn();
  let service: AgentHistorySchemaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    getOrRecompute.mockResolvedValue({
      flatObjectMetadataMaps: createEmptyFlatEntityMaps(),
      flatFieldMetadataMaps: createEmptyFlatEntityMaps(),
      flatIndexMaps: createEmptyFlatEntityMaps(),
      featureFlagsMap: {},
    });
    const module = await Test.createTestingModule({
      providers: [
        AgentHistorySchemaService,
        {
          provide: ApplicationService,
          useValue: {
            findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest
              .fn()
              .mockResolvedValue({
                twentyStandardFlatApplication: {
                  id: APPLICATION_ID,
                  universalIdentifier: APPLICATION_ID,
                },
              }),
          },
        },
        { provide: WorkspaceCacheService, useValue: { getOrRecompute } },
        {
          provide: AgentHistoryLifecycleService,
          useValue: { prepareCoreReferences },
        },
        {
          provide: WorkspaceMigrationValidateBuildAndRunService,
          useValue: { validateBuildAndRunWorkspaceMigrationFromTo: migrate },
        },
      ],
    }).compile();
    service = module.get(AgentHistorySchemaService);
  });

  it('prepares only five standard objects through the standard synchronization path', async () => {
    await service.prepare(WORKSPACE_ID, true);
    const request = migrate.mock.calls[0][0];
    expect(
      Object.keys(
        request.fromToAllFlatEntityMaps.flatObjectMetadataMaps.to
          .byUniversalIdentifier,
      ).sort(),
    ).toEqual(
      [
        STANDARD_OBJECTS.agentChatThread.universalIdentifier,
        STANDARD_OBJECTS.agentTurn.universalIdentifier,
        STANDARD_OBJECTS.agentMessage.universalIdentifier,
        STANDARD_OBJECTS.agentMessagePart.universalIdentifier,
        STANDARD_OBJECTS.agentTurnEvaluation.universalIdentifier,
      ].sort(),
    );
    expect(request.dryRun).toBe(true);
    expect(request.buildOptions.inferDeletionFromMissingEntities).toEqual({});
    expect(prepareCoreReferences).not.toHaveBeenCalled();
  });

  it('does not recreate existing metadata and preserves core deletion constraints', async () => {
    const { allFlatEntityMaps } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: new Date().toISOString(),
        workspaceId: WORKSPACE_ID,
        twentyStandardApplicationId: APPLICATION_ID,
      });
    getOrRecompute.mockResolvedValue({
      ...allFlatEntityMaps,
      featureFlagsMap: {},
    });
    await service.prepare(WORKSPACE_ID, false);
    expect(migrate).not.toHaveBeenCalled();
    expect(prepareCoreReferences).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it('rejects existing history objects whose access policy has drifted', async () => {
    const { allFlatEntityMaps } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: new Date().toISOString(),
        workspaceId: WORKSPACE_ID,
        twentyStandardApplicationId: APPLICATION_ID,
      });
    allFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
      STANDARD_OBJECTS.agentChatThread.universalIdentifier
    ]!.readability = MetadataReadability.OPEN;
    getOrRecompute.mockResolvedValue({
      ...allFlatEntityMaps,
      featureFlagsMap: {},
    });
    await expect(service.prepare(WORKSPACE_ID, false)).rejects.toThrow(
      'protections have drifted',
    );
    expect(migrate).not.toHaveBeenCalled();
  });
});
