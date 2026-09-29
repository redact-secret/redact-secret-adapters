# check=skip=SecretsUsedInArgOrEnv
# (REDACT_SECRET_BENCH_* carry the source commit and image id, never a secret; the
# check matches the "SECRET" in the project name.)
# The Python adapter-overhead harness in a pinned environment (#97). Build and
# run it with `npm run bench:docker -- --python`. Same contract as
# bench.Dockerfile: the image fixes the software, not the hardware.
FROM python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /repo
# The same hash-pinned core, OpenTelemetry SDK and build backend CI installs.
COPY .github/requirements/python-otel.txt .github/requirements/python-otel.txt
RUN python -m pip install --require-hashes -r .github/requirements/python-otel.txt
COPY python ./python
RUN python -m pip install --no-deps --no-build-isolation ./python

COPY scripts ./scripts
COPY fixtures ./fixtures

# The previous release: the highest version on PyPI below python/pyproject.toml's,
# or BASELINE_VERSION. The harness injects this image's core and hosts into both builds.
ARG BASELINE_VERSION=""
RUN python scripts/install-overhead-baseline.py /opt/baseline $BASELINE_VERSION

# A separate copy of this build, for an A/A run (`bench:docker -- --python --aa`).
RUN python -m pip install --quiet --no-deps --no-build-isolation --target /opt/self ./python

ARG SOURCE_COMMIT=""
ARG SOURCE_DIRTY=""
ENV REDACT_SECRET_BENCH_COMMIT=$SOURCE_COMMIT \
    REDACT_SECRET_BENCH_DIRTY=$SOURCE_DIRTY

USER nobody
ENTRYPOINT ["python", "scripts/measure-overhead.py"]
