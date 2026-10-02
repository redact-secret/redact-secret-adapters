# syntax=docker/dockerfile:1.7
# Node consumer image (#192/#193). Build context is testbed/; the staged
# artifacts (tarballs + manifest.json) arrive as the named context 'artifacts'.
# Pin: node 22.16.0 (bookworm-slim). Update path: testbed/README.md "Updating pins".
ARG NODE_IMAGE=node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34

FROM ${NODE_IMAGE} AS install
ARG TESTBED_FAULT=""
ENV TESTBED_FAULT=${TESTBED_FAULT}
RUN mkdir -p /opt/consumer && chown node:node /opt/consumer
USER node
WORKDIR /opt/consumer
COPY --chown=node:node services/node-consumer/install-and-verify.mjs /tmp/install-and-verify.mjs
RUN --mount=type=bind,from=artifacts,target=/artifacts,readonly \
    HOME=/tmp/home node /tmp/install-and-verify.mjs

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
COPY --from=install --chown=root:root /opt/consumer /opt/consumer
COPY contract/ /opt/consumer/contract/
COPY services/node-consumer/server.mjs /opt/consumer/server.mjs
COPY services/node-consumer/lib/ /opt/consumer/lib/
COPY services/node-consumer/scenarios/ /opt/consumer/scenarios/
USER node
WORKDIR /opt/consumer
EXPOSE 8080 8081
CMD ["node", "server.mjs"]
