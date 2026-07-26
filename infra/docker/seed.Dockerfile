# Runner for infra/scripts/seed.py.
#
# The seed script imports PersonaSpec from apps/agent to prove the round-trip
# against the real model rather than a copy of it, so this image carries the
# agent's validation deps (pydantic, pyyaml) plus a Postgres driver. It never
# installs the agent package itself — the repo is mounted read-only and put on
# PYTHONPATH.

FROM python:3.12-slim

RUN pip install --no-cache-dir \
        "psycopg[binary]>=3.2" \
        "pydantic>=2.9" \
        "pyyaml>=6.0"

ENV PYTHONPATH=/repo/apps/agent/src \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /repo
ENTRYPOINT ["python", "/repo/infra/scripts/seed.py"]
