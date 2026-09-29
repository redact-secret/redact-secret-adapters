# check=skip=SecretsUsedInArgOrEnv
# (REDACT_SECRET_BENCH_* carry the source commit and image id, never a secret; the
# check matches the "SECRET" in the project name.)
# The adapter-overhead harness in a pinned environment (#97). Build and run it
# with `npm run bench:docker`, which also records this image's id in the output.
#
# The image fixes the software (Node, OS libraries, the core's native addon,
# the lockfile's dependencies, and the previous release's adapters). It does
# not fix the hardware: compare numbers across machines only as the
# same-session baseline-vs-current change, never as absolute microseconds.
# The base is pinned by digest, and Dependabot tracks it.
FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2

ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci && npm run build

COPY scripts ./scripts
COPY fixtures ./fixtures

# The previous release of every adapter: the highest version published below
# each workspace's own, or the `name@version` overrides in BASELINE_PACKAGES.
# The harness injects this tree's core and hosts into both builds.
ARG BASELINE_PACKAGES=""
RUN node scripts/install-overhead-baseline.mjs /opt/baseline $BASELINE_PACKAGES

# A separate copy of this build, for an A/A run (`bench:docker -- --aa`): the
# current build timed against itself shows the noise floor of the machine.
RUN for dir in packages/*/; do \
      name=$(node -p "require('./${dir}package.json').name"); \
      mkdir -p "/opt/self/node_modules/${name}" && cp -R "${dir}package.json" "${dir}dist" "/opt/self/node_modules/${name}/"; \
    done

# No .git in the image: the runner passes the source commit in.
ARG SOURCE_COMMIT=""
ARG SOURCE_DIRTY=""
ENV REDACT_SECRET_BENCH_COMMIT=$SOURCE_COMMIT \
    REDACT_SECRET_BENCH_DIRTY=$SOURCE_DIRTY

USER node
ENTRYPOINT ["node", "scripts/measure-overhead.mjs"]
