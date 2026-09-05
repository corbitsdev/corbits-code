FROM ubuntu:24.04

WORKDIR /app

# git is required by Corbits storage; curl helps the adapter fetch a binary.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
  && rm -rf /var/lib/apt/lists/*
