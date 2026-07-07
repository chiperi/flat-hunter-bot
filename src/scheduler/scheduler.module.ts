import { Module } from '@nestjs/common';
import { OlxScraperModule } from '../olx-scraper/olx-scraper.module';
import { SearchProfilesModule } from '../search-profiles/search-profiles.module';
import { TelegramModule } from '../telegram/telegram.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [OlxScraperModule, SearchProfilesModule, TelegramModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
