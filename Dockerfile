FROM --platform=${BUILDPLATFORM:-amd64} oven/bun:1.2.23-alpine AS build_src
WORKDIR /usr/app
RUN apk update && apk add --no-cache g++ make python3 git py3-setuptools && rm -rf /var/cache/apk/*

COPY . .

RUN bun install --frozen-lockfile && \
  bun run build:all && \
  bun install --production

RUN cd node_modules/bcrypto && bun install

FROM oven/bun:1.2.23-alpine
WORKDIR /usr/app
COPY --from=build_src /usr/app .

# JSON logs (one object per line, with traceId) so Loki can parse the fields.
# Override with LOG_FORMAT=pretty for human-readable output.
ENV LOG_FORMAT=json

ENTRYPOINT ["bun", "--bun", "./packages/cli/bin/skandha"]