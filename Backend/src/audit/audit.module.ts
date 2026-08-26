import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditService } from './audit.service';
import {
  AuditController,
  AuditVerificationController,
} from './audit.controller';
import { AuditLog, AuditLogArchive } from './audit.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, AuditLogArchive])],
  providers: [
    {
      provide: 'AuditService',
      useExisting: AuditService,
    },
    AuditService,
  ],
  controllers: [AuditController, AuditVerificationController],
  exports: [AuditService, 'AuditService'],
})
export class AuditModule {}
