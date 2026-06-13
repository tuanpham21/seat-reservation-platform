#!/bin/sh
set -eu

npx prisma migrate deploy
npm run db:seed

exec ./node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
