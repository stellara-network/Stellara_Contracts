import { Injectable } from '@nestjs/common';

import { AuditService } from './audit.service';
import { AuditEvent } from './audit.event';

@Injectable()
export class AuditListener {
  constructor(private readonly auditService: AuditService) {}

  async handleAudit(event: AuditEvent) {
    await this.auditService.logAction(
      event.action_type,
      event.actor_id,
      event.entity_id,
      event.metadata,
    );
  }
}
