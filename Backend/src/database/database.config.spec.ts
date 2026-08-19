import { buildTypeOrmOptions } from './database.config';

describe('Database Config', () => {
  describe('buildTypeOrmOptions', () => {
    it('should apply connection pool configuration with correct values', () => {
      const config = {
        host: 'localhost',
        port: 5432,
        username: 'testuser',
        password: 'testpass',
        database: 'testdb',
      };

      const options = buildTypeOrmOptions(config);

      expect(options.extra).toEqual({
        max: 20,
        min: 5,
        idleTimeoutMillis: 30000,
      });
    });

    it('should disable synchronize for migration-based schema management', () => {
      const config = {
        host: 'localhost',
        port: 5432,
        username: 'testuser',
        password: 'testpass',
        database: 'testdb',
      };

      const options = buildTypeOrmOptions(config);

      expect(options.synchronize).toBe(false);
    });

    it('should configure retry attempts with delay', () => {
      const config = {
        host: 'localhost',
        port: 5432,
        username: 'testuser',
        password: 'testpass',
        database: 'testdb',
      };

      const options = buildTypeOrmOptions(config);

      expect(options.retryAttempts).toBe(5);
      expect(options.retryDelay).toBe(3000);
    });

    it('should use provided database connection configuration', () => {
      const config = {
        host: 'db.example.com',
        port: 5433,
        username: 'dbuser',
        password: 'secret',
        database: 'production_db',
      };

      const options = buildTypeOrmOptions(config) as any;

      expect(options.host).toBe('db.example.com');
      expect(options.port).toBe(5433);
      expect(options.username).toBe('dbuser');
      expect(options.password).toBe('secret');
      expect(options.database).toBe('production_db');
    });

    it('should set correct entity and migration paths for production', () => {
      const config = {
        host: 'localhost',
        port: 5432,
        username: 'testuser',
        password: 'testpass',
        database: 'testdb',
      };

      const options = buildTypeOrmOptions(config);

      expect(options.entities).toEqual(['dist/**/*.entity{.ts,.js}']);
      expect(options.migrations).toEqual([
        'dist/database/migrations/*{.ts,.js}',
      ]);
    });
  });
});
