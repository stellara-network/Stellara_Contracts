import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, createHash } from 'crypto';
import { In, Repository } from 'typeorm';
import { AuditLog, AuditLogArchive, AuditLogEntry } from './audit.entity';

export interface AuditVerificationResult {
  valid: boolean;
  checkedEntries: number;
  failures: Array<{
    id: string;
    reason: string;
  }>;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    @InjectRepository(AuditLogArchive)
    private readonly auditArchiveRepo: Repository<AuditLogArchive>,
    private readonly configService: ConfigService,
  ) {}

  async logAction(
    action_type: string,
    actor_id: string,
    entity_id?: string,
    metadata?: Record<string, any>,
  ): Promise<AuditLog> {
    const timestamp = new Date();
    const previousEntry = await this.getLatestEntry();
    const previousHash = previousEntry?.hash ?? '';
    const log = this.auditRepo.create({
      action_type,
      actor_id,
      entity_id,
      metadata,
      timestamp,
      previousHash,
    });
    log.hash = this.computeHash(log);
    log.signature = this.computeSignature(log);
    return this.auditRepo.save(log);
  }

  // Add this for tests
  async clearAllLogs() {
    await this.auditArchiveRepo.clear();
    await this.auditRepo.clear();
  }

  async getLogs(
    page = 1,
    limit = 20,
    filter?: {
      action_type?: string;
      actor_id?: string;
      entity_id?: string;
      from?: string;
      to?: string;
    },
  ): Promise<{ data: AuditLog[]; total: number }> {
    const query = this.auditRepo.createQueryBuilder('audit');

    if (filter) {
      if (filter.action_type)
        query.andWhere('audit.action_type = :action_type', {
          action_type: filter.action_type,
        });
      if (filter.actor_id)
        query.andWhere('audit.actor_id = :actor_id', {
          actor_id: filter.actor_id,
        });
      if (filter.entity_id)
        query.andWhere('audit.entity_id = :entity_id', {
          entity_id: filter.entity_id,
        });
      if (filter.from)
        query.andWhere('audit.timestamp >= :from', { from: filter.from });
      if (filter.to)
        query.andWhere('audit.timestamp <= :to', { to: filter.to });
    }

    const [data, total] = await query
      .orderBy('audit.timestamp', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total };
  }

  async verifyAuditChain(): Promise<AuditVerificationResult> {
    const entries = await this.getOrderedEntries();
    const failures: AuditVerificationResult['failures'] = [];
    let previousHash = '';

    for (const entry of entries) {
      const expectedHash = this.computeHash({
        ...entry,
        previousHash,
      });
      const expectedSignature = this.computeSignature({
        ...entry,
        previousHash,
        hash: expectedHash,
      });

      if (entry.previousHash !== previousHash) {
        failures.push({
          id: entry.id,
          reason: 'previousHash does not match previous entry hash',
        });
      }

      if (entry.hash !== expectedHash) {
        failures.push({
          id: entry.id,
          reason: 'hash does not match entry contents',
        });
      }

      if (entry.signature !== expectedSignature) {
        failures.push({
          id: entry.id,
          reason: 'signature does not match entry contents',
        });
      }

      previousHash = entry.hash;
    }

    return {
      valid: failures.length === 0,
      checkedEntries: entries.length,
      failures,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async archiveOldLogs(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    const oldLogs = await this.auditRepo
      .createQueryBuilder('audit')
      .where('audit.timestamp < :cutoff', { cutoff })
      .orderBy('audit.timestamp', 'ASC')
      .addOrderBy('audit.id', 'ASC')
      .getMany();

    if (oldLogs.length === 0) {
      return 0;
    }

    const archives = oldLogs.map((log) =>
      this.auditArchiveRepo.create({
        id: log.id,
        action_type: log.action_type,
        actor_id: log.actor_id,
        entity_id: log.entity_id,
        metadata: log.metadata,
        timestamp: log.timestamp,
        previousHash: log.previousHash,
        hash: log.hash,
        signature: log.signature,
      }),
    );

    await this.auditArchiveRepo.save(archives);
    await this.auditRepo.delete({ id: In(oldLogs.map((log) => log.id)) });

    return oldLogs.length;
  }

  private async getLatestEntry(): Promise<AuditLogEntry | null> {
    const [latestLog, latestArchive] = await Promise.all([
      this.auditRepo.findOne({ order: { timestamp: 'DESC', id: 'DESC' } }),
      this.auditArchiveRepo.findOne({
        order: { timestamp: 'DESC', id: 'DESC' },
      }),
    ]);

    if (!latestLog) {
      return latestArchive;
    }

    if (!latestArchive) {
      return latestLog;
    }

    return this.compareEntries(latestLog, latestArchive) >= 0
      ? latestLog
      : latestArchive;
  }

  private async getOrderedEntries(): Promise<AuditLogEntry[]> {
    const [logs, archives] = await Promise.all([
      this.auditRepo.find({ order: { timestamp: 'ASC', id: 'ASC' } }),
      this.auditArchiveRepo.find({ order: { timestamp: 'ASC', id: 'ASC' } }),
    ]);

    return [...archives, ...logs].sort((a, b) => this.compareEntries(a, b));
  }

  private compareEntries(a: AuditLogEntry, b: AuditLogEntry): number {
    const timestampDiff =
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();

    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    return a.id.localeCompare(b.id);
  }

  private computeHash(
    entry: Pick<
      AuditLogEntry,
      'previousHash' | 'action_type' | 'actor_id' | 'timestamp'
    >,
  ): string {
    return createHash('sha256')
      .update(
        `${entry.previousHash}${entry.action_type}${entry.actor_id}${this.formatTimestamp(entry.timestamp)}`,
      )
      .digest('hex');
  }

  private computeSignature(
    entry: Pick<
      AuditLogEntry,
      | 'action_type'
      | 'actor_id'
      | 'entity_id'
      | 'metadata'
      | 'timestamp'
      | 'previousHash'
      | 'hash'
    >,
  ): string {
    return createHmac('sha256', this.getHmacKey())
      .update(
        JSON.stringify({
          action_type: entry.action_type,
          actor_id: entry.actor_id,
          entity_id: entry.entity_id ?? null,
          metadata: this.sortObject(entry.metadata ?? null),
          timestamp: this.formatTimestamp(entry.timestamp),
          previousHash: entry.previousHash,
          hash: entry.hash,
        }),
      )
      .digest('hex');
  }

  private formatTimestamp(timestamp: Date): string {
    return new Date(timestamp).toISOString();
  }

  private sortObject(value: any): any {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortObject(item));
    }

    if (value && typeof value === 'object') {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = this.sortObject(value[key]);
          return result;
        }, {});
    }

    return value;
  }

  private getHmacKey(): string {
    return this.configService.get<string>(
      'AUDIT_LOG_HMAC_KEY',
      'change-this-audit-log-hmac-key',
    );
  }
}
