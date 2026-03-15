import type { z } from 'zod';

import type { appConfigSchema } from '../config/schema';

export type AppConfig = z.infer<typeof appConfigSchema>;

export type ScopeMode = 'global' | 'project';

export type SearchOutputFormat = 'text' | 'json';

export type WebFetchMode = 'auto' | 'get' | 'fetch';
