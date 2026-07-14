import Redis from 'ioredis-mock';
import { SeenListingsRepository } from './seen-listings.repository';

const config = { get: () => ({ keyPrefix: 'olx' }) } as any;

describe('SeenListingsRepository', () => {
  let redis: any;
  let repo: SeenListingsRepository;

  beforeEach(async () => {
    redis = new Redis();
    await redis.flushall();
    repo = new SeenListingsRepository(redis, config);
  });

  it('markSeen + getAll encodes/decodes prices (incl. null)', async () => {
    await repo.markSeen('p', 'l1', 10000);
    await repo.markSeen('p', 'l2', null);
    const map = await repo.getAll('p');
    expect(map.get('l1')).toBe(10000);
    expect(map.get('l2')).toBeNull();
  });

  it('decodes a non-numeric stored value as null', async () => {
    await redis.hset('olx:seen:p', 'l3', 'garbage');
    expect((await repo.getAll('p')).get('l3')).toBeNull();
  });

  it('seed writes many at once; clear empties', async () => {
    await repo.seed('p', [
      { id: 'a', price: 1 },
      { id: 'b', price: null },
    ]);
    expect((await repo.getAll('p')).size).toBe(2);
    await repo.clear('p');
    expect((await repo.getAll('p')).size).toBe(0);
  });

  it('seed([]) is a no-op', async () => {
    await repo.seed('p', []);
    expect((await repo.getAll('p')).size).toBe(0);
  });
});
