import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './audit.entity';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  async logAction(
    action_type: string,
    actor_id: string,
    entity_id?: string,
    metadata?: Record<string, any>,
  ): Promise<AuditLog> {
    const log = this.auditRepo.create({ action_type, actor_id, entity_id, metadata });
    return this.auditRepo.save(log);
  }

   // Add this for tests
  async clearAllLogs() {
    await this.auditRepo.clear();
  }


  async getLogs(
    page = 1,
    limit = 20,
    filter?: { action_type?: string; actor_id?: string; entity_id?: string; from?: string; to?: string },
  ): Promise<{ data: AuditLog[]; total: number }> {
    const query = this.auditRepo.createQueryBuilder('audit');

    if (filter) {
      if (filter.action_type) query.andWhere('audit.action_type = :action_type', { action_type: filter.action_type });
      if (filter.actor_id) query.andWhere('audit.actor_id = :actor_id', { actor_id: filter.actor_id });
      if (filter.entity_id) query.andWhere('audit.entity_id = :entity_id', { entity_id: filter.entity_id });
      if (filter.from) query.andWhere('audit.timestamp >= :from', { from: filter.from });
      if (filter.to) query.andWhere('audit.timestamp <= :to', { to: filter.to });
    }

    const [data, total] = await query
      .orderBy('audit.timestamp', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total };
  }
}
