import { Controller, Get, Post } from '@nestjs/common';
import { Roles } from '../../decorators/roles.decorator';
import { Role } from '../../auth/roles.enum';

@Controller('admin')
export class AdminController {
  @Get('audit-logs')
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  getAuditLogs() {
    return { message: 'Audit logs accessed' };
  }

  @Post('job-requeue')
  @Roles(Role.ADMIN, Role.SUPERADMIN)
  requeueJob() {
    return { message: 'Job requeued' };
  }

  @Post('moderate-content')
  @Roles(Role.MODERATOR, Role.ADMIN, Role.SUPERADMIN)
  moderateContent() {
    return { message: 'Content moderated' };
  }

  @Post('webhooks')
  @Roles(Role.SUPERADMIN)
  registerWebhook() {
    return { message: 'Webhook registered' };
  }
}
