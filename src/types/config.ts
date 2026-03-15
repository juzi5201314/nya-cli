import type { z } from 'zod';

import type { appConfigSchema } from '../config/schema';

export type AppConfig = z.infer<typeof appConfigSchema>;

export type ScopeMode = 'global' | 'project';

export type SearchOutputFormat = 'text' | 'json';

export type WebFetchMode =
  AppConfig['web']['ingest']['providers']['scrapling']['default_fetch_mode'];
