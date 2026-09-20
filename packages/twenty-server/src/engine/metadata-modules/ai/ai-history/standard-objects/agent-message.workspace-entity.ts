import { type AgentChatThreadWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-chat-thread.workspace-entity';
import { type AgentTurnWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-turn.workspace-entity';
import { type AgentMessagePartWorkspaceEntity } from 'src/engine/metadata-modules/ai/ai-history/standard-objects/agent-message-part.workspace-entity';
import { BaseWorkspaceEntity } from 'src/engine/twenty-orm/base.workspace-entity';
import {
  type AgentMessageRole,
  type AgentMessageStatus,
} from 'src/engine/metadata-modules/ai/ai-agent-execution/entities/agent-message.entity';

export class AgentMessageWorkspaceEntity extends BaseWorkspaceEntity {
  thread: AgentChatThreadWorkspaceEntity | null;
  turn: AgentTurnWorkspaceEntity | null;
  parts: AgentMessagePartWorkspaceEntity[];

  threadId: string;
  turnId: string | null;
  agentId: string | null;
  role: AgentMessageRole;
  status: AgentMessageStatus;
  isHidden: boolean;
  processedAt: string | null;
}
