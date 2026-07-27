FROM rust:1.95-bookworm AS builder

ARG BINARY
WORKDIR /build
COPY services/indexer/ ./
RUN cargo build --locked --release --bin "${BINARY}"

FROM debian:bookworm-slim AS runtime

ARG BINARY
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 service
COPY --from=builder "/build/target/release/${BINARY}" /usr/local/bin/service
USER service
ENTRYPOINT ["/usr/local/bin/service"]
