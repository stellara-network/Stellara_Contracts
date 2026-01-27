export class AuditEvent {
  constructor(
    public readonly action_type: string,
    public readonly actor_id: string,
    public readonly entity_id?: string,
    public readonly metadata?: Record<string, any>,
  ) {}
}
