# Dockerfile for DevContainer
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# Install essential packages
RUN apt-get update && apt-get install -y \
    curl \
    bash \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set up PNPM
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

# Create workspace directory
WORKDIR /workspaces/dokploy

# Set up user permissions
USER node
