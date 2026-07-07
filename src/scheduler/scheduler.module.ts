import { Module } from '@nestjs/common';
import { SourcesModule } from '../sources/sources.module';
import { SearchProfilesModule } from '../search-profiles/search-profiles.module';
import { TelegramModule } from '../telegram/telegram.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [SourcesModule, SearchProfilesModule, TelegramModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
