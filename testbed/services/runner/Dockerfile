# syntax=docker/dockerfile:1.7
# Playwright + scenario runner (#192). The image tag must match @playwright/test
# in package.json (1.55.0). Update path: testbed/README.md "Updating pins".
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.55.0-noble@sha256:b27e719ecbfef153e13fd24e8341736733bf2658b229677eb21ff57ff5d7fb29
FROM ${PLAYWRIGHT_IMAGE}
ENV NODE_ENV=development HOME=/tmp
WORKDIR /runner
COPY services/runner/package.json services/runner/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY services/runner/ ./
COPY contract/ ./contract/
CMD ["sh", "-c", "node run-scenarios.mjs; s=$?; npx playwright test; p=$?; [ $s -eq 0 ] && [ $p -eq 0 ]"]
