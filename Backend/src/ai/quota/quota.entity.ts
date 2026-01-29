import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity()
@Index(['userId', 'month'], { unique: true })
export class AiUsageQuota {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  month: string; // YYYY-MM

  @Column({ default: 0 })
  requestCount: number;

  @Column({ default: 0 })
  tokenCount: number;
}
