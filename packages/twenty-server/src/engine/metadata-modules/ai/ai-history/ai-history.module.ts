import { Module } from '@nestjs/common';
import { AgentHistoryStorageService } from 'src/engine/metadata-modules/ai/ai-history/services/agent-history-storage.service';
import { AgentHistoryRepository } from 'src/engine/metadata-modules/ai/ai-history/repositories/agent-history-repository';
import { getAgentHistoryRepositoryToken } from 'src/engine/metadata-modules/ai/ai-history/repositories/inject-agent-history-repository.decorator';
import { WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';
import { AgentChatThreadEntity } from 'src/engine/metadata-modules/ai/ai-chat/entities/agent-chat-thread.entity';
import { AgentMessageEntity } from 'src/engine/metadata-modules/ai/ai-agent-execution/entities/agent-message.entity';
import { AgentMessagePartEntity } from 'src/engine/metadata-modules/ai/ai-agent-execution/entities/agent-message-part.entity';
import { AgentTurnEntity } from 'src/engine/metadata-modules/ai/ai-agent-execution/entities/agent-turn.entity';
import { AgentTurnEvaluationEntity } from 'src/engine/metadata-modules/ai/ai-agent-monitor/entities/agent-turn-evaluation.entity';

const providers = [
  {
    provide: getAgentHistoryRepositoryToken('agentChatThread'),
    useFactory: (
      storage: AgentHistoryStorageService,
      orm: WorkspaceOrmManager,
    ) =>
      new AgentHistoryRepository(
        'agentChatThread',
        AgentChatThreadEntity,
        storage,
        orm,
      ),
    inject: [AgentHistoryStorageService, WorkspaceOrmManager],
  },
  {
    provide: getAgentHistoryRepositoryToken('agentMessage'),
    useFactory: (
      storage: AgentHistoryStorageService,
      orm: WorkspaceOrmManager,
    ) =>
      new AgentHistoryRepository(
        'agentMessage',
        AgentMessageEntity,
        storage,
        orm,
      ),
    inject: [AgentHistoryStorageService, WorkspaceOrmManager],
  },
  {
    provide: getAgentHistoryRepositoryToken('agentMessagePart'),
    useFactory: (
      storage: AgentHistoryStorageService,
      orm: WorkspaceOrmManager,
    ) =>
      new AgentHistoryRepository(
        'agentMessagePart',
        AgentMessagePartEntity,
        storage,
        orm,
      ),
    inject: [AgentHistoryStorageService, WorkspaceOrmManager],
  },
  {
    provide: getAgentHistoryRepositoryToken('agentTurn'),
    useFactory: (
      storage: AgentHistoryStorageService,
      orm: WorkspaceOrmManager,
    ) => new AgentHistoryRepository('agentTurn', AgentTurnEntity, storage, orm),
    inject: [AgentHistoryStorageService, WorkspaceOrmManager],
  },
  {
    provide: getAgentHistoryRepositoryToken('agentTurnEvaluation'),
    useFactory: (
      storage: AgentHistoryStorageService,
      orm: WorkspaceOrmManager,
    ) =>
      new AgentHistoryRepository(
        'agentTurnEvaluation',
        AgentTurnEvaluationEntity,
        storage,
        orm,
      ),
    inject: [AgentHistoryStorageService, WorkspaceOrmManager],
  },
];

@Module({
  providers: [
    AgentHistoryStorageService,

    ...providers,
  ],
  exports: [
    AgentHistoryStorageService,

    ...providers,
  ],
})
export class AgentHistoryModule {}
