import { Logger, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { HttpOlxScraper } from './http-olx.scraper';
import { MockOlxScraper } from './mock-olx.scraper';
import { OLX_SCRAPER } from './olx-scraper.interface';

/**
 * Binds the `OLX_SCRAPER` token to a concrete strategy chosen by SCRAPER env.
 * Both implementations are constructed so switching is a config change, never a
 * code change in consumers.
 */
const scraperProvider: Provider = {
  provide: OLX_SCRAPER,
  inject: [ConfigService, MockOlxScraper, HttpOlxScraper],
  useFactory: (
    config: ConfigService<AppConfig, true>,
    mock: MockOlxScraper,
    http: HttpOlxScraper,
  ) => {
    const kind = config.get('scraper', { infer: true }).kind;
    new Logger('OlxScraperModule').log(`Using "${kind}" scraper strategy`);
    return kind === 'http' ? http : mock;
  },
};

@Module({
  providers: [MockOlxScraper, HttpOlxScraper, scraperProvider],
  exports: [OLX_SCRAPER],
})
export class OlxScraperModule {}
