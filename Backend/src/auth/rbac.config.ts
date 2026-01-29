import { Role } from './roles.enum';
import { Permission } from './permissions.enum';

export const RBAC_CONFIG: Record<Role, Permission[]> = {
  [Role.USER]: [],

  [Role.MODERATOR]: [
    Permission.MODERATE_CONTENT,
  ],

  [Role.ADMIN]: [
    Permission.MODERATE_CONTENT,
    Permission.VIEW_AUDIT_LOGS,
    Permission.REQUEUE_JOBS,
  ],

  [Role.SUPERADMIN]: Object.values(Permission),
};
