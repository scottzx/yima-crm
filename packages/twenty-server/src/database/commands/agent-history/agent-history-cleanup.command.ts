import { Command, Option } from 'nest-commander';
import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import {
  type RunOnWorkspaceArgs,
  type WorkspaceCommandOptions,
} from 'src/database/commands/command-runners/workspace.command-runner';
import { AgentHistoryMigrationService } from 'src/database/commands/agent-history/agent-history-migration.service';

type Options = WorkspaceCommandOptions & { retentionDays?: number };

@Command({
  name: 'agent-history:cleanup',
  description:
    'Delete obsolete core snapshots after verified cutover and the rollback retention window',
})
export class AgentHistoryCleanupCommand extends ProvisionedWorkspaceCommandRunner<Options> {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly migration: AgentHistoryMigrationService,
  ) {
    super(workspaceIteratorService);
  }

  @Option({
    flags: '--retention-days <days>',
    description: 'Minimum age of verified cutover (default 14, minimum 1)',
  })
  parseRetentionDays(value: string): number {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1)
      throw new Error('Retention must be at least one day');
    return days;
  }

  override async runOnWorkspace({
    workspaceId,
    options,
  }: RunOnWorkspaceArgs): Promise<void> {
    await this.migration.cleanup(
      workspaceId,
      options.dryRun ?? false,
      (options as Options).retentionDays ?? 14,
    );
  }
}
