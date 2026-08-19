import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmOptions } from './database.config';

@Module({
  imports: [
    TypeOrmModule.forRoot(
      buildTypeOrmOptions({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        username: process.env.DB_USERNAME || 'postgres',
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE || 'stellara_workflows',
      }),
    ),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
