import { Module } from '@nestjs/common';
import { SearchProfilesService } from './search-profiles.service';

@Module({
  providers: [SearchProfilesService],
  exports: [SearchProfilesService],
})
export class SearchProfilesModule {}
