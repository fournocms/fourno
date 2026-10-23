# syntax=docker/dockerfile:1

# The one place the Node major lives for the image. pnpm's version is not
# repeated here: corepack reads it from package.json "packageManager".
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
# vendor/pixel-art-icons is a `file:` dep — `pnpm install` needs it on disk to
# resolve the dependency, so copy it alongside the manifest before installing.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS production-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ARG FOURNO_VERSION=dev
ARG FOURNO_REVISION=unknown
ARG FOURNO_CREATED=unknown

LABEL org.opencontainers.image.title="Fourno"
LABEL org.opencontainers.image.description="Self-hosted CMS with an integrated visual editor."
LABEL org.opencontainers.image.source="https://github.com/fourno/fourno"
LABEL org.opencontainers.image.url="https://github.com/fourno/fourno"
LABEL org.opencontainers.image.documentation="https://github.com/fourno/fourno/tree/main/docs/deployment"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${FOURNO_VERSION}"
LABEL org.opencontainers.image.revision="${FOURNO_REVISION}"
LABEL org.opencontainers.image.created="${FOURNO_CREATED}"

ENV NODE_ENV=production
ENV PORT=3001
ENV STATIC_DIR=/app/dist
ENV UPLOADS_DIR=/app/uploads

COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node tsconfig*.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src

RUN mkdir -p /app/uploads /app/data && chown -R node:node /app

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "--import", "tsx", "server/healthcheck.ts"]

CMD ["node", "--import", "tsx", "server/index.ts"]
