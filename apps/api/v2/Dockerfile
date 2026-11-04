FROM node:24.22.0-alpine AS build
COPY --from=oven/bun:1.4.4-alpine /usr/local/bin/bun /usr/local/bin/bun

ARG DATABASE_DIRECT_URL
ARG DATABASE_URL

WORKDIR /calcom

RUN set -eux;
RUN ln -s /usr/lib/libssl.so.3 /lib/libssl.so.3

ENV NODE_ENV="production"
ENV NODE_OPTIONS="--max-old-space-size=8192"
ENV DATABASE_DIRECT_URL=${DATABASE_DIRECT_URL}
ENV DATABASE_URL=${DATABASE_URL}
ENV USE_POOL="true"

COPY . .

RUN bun install --frozen-lockfile
RUN bun run --cwd apps/api/v2 generate-schemas
RUN bun run --cwd apps/api/v2 build:docker
RUN bun run --cwd apps/api/v2 build

EXPOSE 80

CMD ["bun", "run", "--cwd", "apps/api/v2", "start:prod"]
