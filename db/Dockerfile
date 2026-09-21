FROM pgvector/pgvector:pg17
RUN apt-get update && apt-get install -y --no-install-recommends build-essential postgresql-server-dev-17 git ca-certificates \
    && git clone --depth 1 --branch REL1_2_STABLE https://github.com/pgbigm/pg_bigm.git /tmp/pg_bigm \
    && cd /tmp/pg_bigm && make USE_PGXS=1 && make USE_PGXS=1 install \
    && rm -rf /tmp/pg_bigm /var/lib/apt/lists/*
