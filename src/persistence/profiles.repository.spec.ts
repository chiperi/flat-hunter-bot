import Redis from 'ioredis-mock';
import { ProfilesRepository } from './profiles.repository';
import { SearchProfile } from '../search-profiles/search-profile.model';

const config = { get: () => ({ keyPrefix: 'olx' }) } as any;

const profile = (over: Partial<SearchProfile> = {}): SearchProfile => ({
  id: 'p1',
  userId: 1,
  chatId: 1,
  name: 'n',
  criteria: { city: 'Київ', ownerOnly: false },
  paused: false,
  primed: false,
  createdAt: 1,
  ...over,
});

describe('ProfilesRepository', () => {
  let redis: any;
  let repo: ProfilesRepository;

  beforeEach(async () => {
    redis = new Redis();
    await redis.flushall();
    repo = new ProfilesRepository(redis, config);
  });

  it('save + get round-trips a profile', async () => {
    const p = profile();
    await repo.save(p);
    expect(await repo.get('p1')).toEqual(p);
  });

  it('returns null for a missing id', async () => {
    expect(await repo.get('nope')).toBeNull();
  });

  it('listByUser returns newest-first', async () => {
    await repo.save(profile({ id: 'a', createdAt: 1 }));
    await repo.save(profile({ id: 'b', createdAt: 5 }));
    expect((await repo.listByUser(1)).map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('listAll spans users; listIdsByUser is scoped', async () => {
    await repo.save(profile({ id: 'a', userId: 1 }));
    await repo.save(profile({ id: 'b', userId: 2 }));
    expect((await repo.listAll()).length).toBe(2);
    expect(await repo.listIdsByUser(1)).toEqual(['a']);
  });

  it('delete removes the record and set membership', async () => {
    const p = profile();
    await repo.save(p);
    await repo.delete(p);
    expect(await repo.get('p1')).toBeNull();
    expect(await repo.listByUser(1)).toEqual([]);
    expect(await repo.listAll()).toEqual([]);
  });

  it('loadMany returns [] for an unknown user', async () => {
    expect(await repo.listByUser(999)).toEqual([]);
  });
});
