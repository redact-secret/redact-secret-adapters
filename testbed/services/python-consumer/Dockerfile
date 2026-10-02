# syntax=docker/dockerfile:1.7
# Python consumer image (#192/#193). Build context is testbed/; the staged
# wheel and manifest.json arrive as the named context 'artifacts'.
# Pin: python 3.12.11 (bookworm-slim). Update path: testbed/README.md "Updating pins".
ARG PYTHON_IMAGE=python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7

FROM ${PYTHON_IMAGE} AS install
ARG TESTBED_FAULT=""
ENV TESTBED_FAULT=${TESTBED_FAULT} PIP_NO_CACHE_DIR=1
RUN mkdir -p /opt/consumer
COPY services/python-consumer/install_and_verify.py /tmp/install_and_verify.py
RUN --mount=type=bind,from=artifacts,target=/artifacts,readonly \
    python /tmp/install_and_verify.py

FROM ${PYTHON_IMAGE}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH
RUN useradd --system --uid 10001 --no-create-home consumer
COPY --from=install /opt/venv /opt/venv
COPY --from=install /opt/consumer/install-manifest.json /opt/consumer/install-manifest.json
COPY contract/ /app/contract/
COPY services/python-consumer/server.py services/python-consumer/captures.py /app/
COPY services/python-consumer/scenarios/ /app/scenarios/
USER consumer
WORKDIR /app
EXPOSE 8080 8081
CMD ["/opt/venv/bin/python", "server.py"]
