import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// DIRECT_URL is the NON-pooled Neon connection string. Only commands that talk to the database
// (migrate, db) need it; `prisma generate` must keep working without any environment so that a
// fresh clone, CI and `npm install` succeed. Prisma fails with a clear message if it is missing.
const directUrl = process.env.DIRECT_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(directUrl ? { datasource: { url: directUrl } } : {}),
});
