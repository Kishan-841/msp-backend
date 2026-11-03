#!/bin/sh
# Bring the database schema up to date, then start the API.
#
# `prisma db push` refuses changes that would lose data (e.g. dropping a column with values) and
# the container then stops with that message instead of starting. Review it, back up, and run
#   docker compose run --rm api npx prisma db push --accept-data-loss
# by hand only if the loss is intended. Set SKIP_DB_PUSH=true to skip this step.
set -e

if [ "$SKIP_DB_PUSH" != "true" ]; then
  echo "Applying database schema (prisma db push)…"
  tries=0
  until npx prisma db push; do
    tries=$((tries + 1))
    if [ "$tries" -ge 10 ]; then
      echo "prisma db push failed — see the message above. Not starting the API."
      exit 1
    fi
    echo "Database not ready or push failed, retrying in 3s ($tries/10)…"
    sleep 3
  done
fi

exec "$@"
