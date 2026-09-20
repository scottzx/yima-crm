import { type AgentChatThreadWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-chat-thread.workspace-entity';
import { type AgentMessageWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-message.workspace-entity';
import { type AgentTurnEvaluationWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-turn-evaluation.workspace-entity';
import { BaseWorkspaceEntity } from 'src/engine/twenty-orm/base.workspace-entity';

export class AgentTurnWorkspaceEntity extends BaseWorkspaceEntity {
  thread: AgentChatThreadWorkspaceEntity | null;
  messages: AgentMessageWorkspaceEntity[];
  evaluations: AgentTurnEvaluationWorkspaceEntity[];

  threadId: string;
  agentId: string | null;
}
