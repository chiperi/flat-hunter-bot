import { Logger, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { HttpListingSource } from './http-listing-source';
import { LISTING_SOURCES } from './listing-source.interface';
import { SITE_SPECS } from './site-specs';
import { SourceRegistry } from './source-registry.service';

/**
 * Builds one `HttpListingSource` per ENABLED site id (from config), all sharing
 * the same mode (mock/http) and HTTP settings. Adding a new site = add a spec
 * in site-specs.ts and its id to KNOWN_SOURCE_IDS — no wiring change here.
 */
const listingSourcesProvider: Provider = {
  provide: LISTING_SOURCES,
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => {
    const cfg = config.get('sources', { infer: true });
    new Logger('SourcesModule').log(
      `mode="${cfg.mode}", sources=[${cfg.enabled.join(', ')}]`,
    );
    return cfg.enabled
      .map((id) => SITE_SPECS[id])
      .filter((spec) => Boolean(spec))
      .map((spec) => new HttpListingSource(spec, cfg));
  },
};

@Module({
  providers: [listingSourcesProvider, SourceRegistry],
  exports: [SourceRegistry],
})
export class SourcesModule {}
