import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { SourcesModule } from './sources/sources.module';
import { PersistenceModule } from './persistence/persistence.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SearchProfilesModule } from './search-profiles/search-profiles.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fails fast at boot with a clear message if required env is missing.
      load: [configuration],
      cache: true,
    }),
    PersistenceModule, // @Global — Redis client + repositories everywhere
    SourcesModule,
    SearchProfilesModule,
    TelegramModule,
    SchedulerModule,
  ],
})
export class AppModule {}
