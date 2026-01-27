import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Roles } from '../decorators/roles.decorator';
import { Role } from '../auth/roles.enum';



@Controller('admin/audit')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('logs')
  @Roles(Role.ADMIN) 
  async getLogs(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('action_type') action_type?: string,
    @Query('actor_id') actor_id?: string,
    @Query('entity_id') entity_id?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.auditService.getLogs(page, limit, { action_type, actor_id, entity_id, from, to });
  }
}
