# syntax=docker/dockerfile:1
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@10.22.0 --activate

FROM base AS build
COPY . /usr/src/app
WORKDIR /usr/src/app

RUN apt-get update && apt-get upgrade -y && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev && rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Deploy only the dokploy app

ENV NODE_ENV=production
RUN pnpm --filter=@dokploy/server build
RUN pnpm --filter=./apps/dokploy run build

RUN pnpm --filter=./apps/dokploy --prod deploy --legacy /prod/dokploy

RUN cp -R /usr/src/app/apps/dokploy/.next /prod/dokploy/.next
RUN cp -R /usr/src/app/apps/dokploy/dist /prod/dokploy/dist

# Runtime does not need pnpm, Corepack, or npm; start from the clean Node image
# instead of the package-manager-enabled build base.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS dokploy
WORKDIR /app

ARG RELEASE_TAG=latest
ARG VCS_REF=unknown

# Set production and expose candidate identity at runtime.
ENV NODE_ENV=production \
  RELEASE_TAG=${RELEASE_TAG}

LABEL org.opencontainers.image.source="https://github.com/budivoogt/dokploy" \
  org.opencontainers.image.version="${RELEASE_TAG}" \
  org.opencontainers.image.revision="${VCS_REF}"

RUN apt-get update && apt-get upgrade -y && apt-get install -y tini curl unzip zip apache2-utils iproute2 rsync git-lfs && git lfs install && rm -rf /var/lib/apt/lists/*

# Copy only the necessary files
COPY --from=build /prod/dokploy/.next ./.next
COPY --from=build /prod/dokploy/dist ./dist
COPY --from=build /prod/dokploy/next.config.mjs ./next.config.mjs
COPY --from=build /prod/dokploy/public ./public
COPY --from=build /prod/dokploy/package.json ./package.json
COPY --from=build /prod/dokploy/drizzle ./drizzle
COPY --from=build /prod/dokploy/components.json ./components.json
COPY --from=build /prod/dokploy/node_modules ./node_modules


COPY --from=docker:29.9.2-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb /usr/local/bin/docker /usr/local/bin/docker
ARG TARGETARCH
RUN test "${TARGETARCH}" = amd64 \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL https://github.com/docker/buildx/releases/download/v0.38.1/buildx-v0.38.1.linux-amd64 -o /usr/local/lib/docker/cli-plugins/docker-buildx \
    && echo 'e25d5cd675092bb5d1d03632fdc46cdf3fede7b514dc5f023a105e00d3ce5ad4  /usr/local/lib/docker/cli-plugins/docker-buildx' | sha256sum -c - \
    && curl -fsSL https://github.com/docker/compose/releases/download/v5.6.1/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && echo '47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0  /usr/local/lib/docker/cli-plugins/docker-compose' | sha256sum -c - \
    && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-compose \
    && curl -fsSL https://github.com/rclone/rclone/releases/download/v1.75.2/rclone-v1.75.2-linux-amd64.zip -o /tmp/rclone.zip \
    && echo '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702  /tmp/rclone.zip' | sha256sum -c - \
    && unzip -q /tmp/rclone.zip -d /tmp/rclone \
    && install -m 0755 /tmp/rclone/rclone-v1.75.2-linux-amd64/rclone /usr/local/bin/rclone \
    && curl -fsSL https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz -o /tmp/nixpacks.tar.gz \
    && echo '0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6  /tmp/nixpacks.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/nixpacks.tar.gz -C /usr/local/bin nixpacks \
    && curl -fsSL https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-x86_64-unknown-linux-musl.tar.gz -o /tmp/railpack.tar.gz \
    && echo '248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb  /tmp/railpack.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/railpack.tar.gz -C /usr/local/bin railpack \
    && curl -fsSL https://github.com/buildpacks/pack/releases/download/v0.40.10/pack-v0.40.10-linux.tgz -o /tmp/pack.tgz \
    && echo '687c3616e21824a449b56d4f989613ca68c921c6cce670b4de4459b025233806  /tmp/pack.tgz' | sha256sum -c - \
    && tar -xzf /tmp/pack.tgz -C /usr/local/bin pack \
    && rm -rf /tmp/rclone /tmp/rclone.zip /tmp/nixpacks.tar.gz /tmp/railpack.tar.gz /tmp/pack.tgz

# The process starts with node directly. Remove package-manager tooling and caches
# from the runtime image so build-only dependencies cannot become scan findings.
RUN rm -rf /root/.cache/node /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

# tini reaps HEALTHCHECK child processes that Node (as PID 1) leaves defunct.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Ejecutar node directamente: pnpm como wrapper queda residente (~100MB RSS)
  CMD ["sh", "-c", "node -r dotenv/config dist/wait-for-postgres.mjs && node -r dotenv/config dist/migration.mjs && exec node -r dotenv/config dist/server.mjs"]
