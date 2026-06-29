export interface ManualCompactRequest {
  focusTopic?: string;
  requestedAt: string;
}

export class ManualCompactCoordinator {
  private readonly pendingByTaskId = new Map<string, ManualCompactRequest>();

  public request(taskId: string, focusTopic?: string): void {
    this.pendingByTaskId.set(taskId, {
      ...(focusTopic !== undefined && focusTopic.trim().length > 0
        ? { focusTopic: focusTopic.trim() }
        : {}),
      requestedAt: new Date().toISOString()
    });
  }

  public consume(taskId: string): ManualCompactRequest | null {
    const pending = this.pendingByTaskId.get(taskId) ?? null;
    if (pending === null) {
      return null;
    }
    this.pendingByTaskId.delete(taskId);
    return pending;
  }
}
