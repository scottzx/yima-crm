export class AgentHistoryStorageException extends Error {
  constructor(
    public readonly code: 'INVALID_STATE' | 'MISSING_STATE',
    message: string,
  ) {
    super(message);
    this.name = 'AgentHistoryStorageException';
  }
}
