# syntax=docker/dockerfile:1.6

# ============================================================
# Stage 1: Build waifu2x-ncnn-vulkan binary (Ubuntu 22.04)
# ============================================================
FROM ubuntu:22.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        ninja-build \
        ca-certificates \
        libvulkan-dev \
        libomp-dev \
        glslang-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY src /src/src
COPY models /src/models

RUN cmake -S /src/src -B /src/build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/opt/waifu2x \
    && cmake --build /src/build -j "$(nproc)" \
    && cmake --build /src/build --target install/strip

# ============================================================
# Stage 2: Install Node.js 20 onto Ubuntu 22.04 runtime
#   - Same glibc/libgomp as the builder → no ABI mismatch
#   - No mesa-vulkan-drivers: llvmpipe software Vulkan causes
#     ncnn to crash even in CPU mode (-g -1). Real GPU ICDs are
#     provided at runtime via Docker device passthrough instead.
# ============================================================
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# Node.js 20 via NodeSource
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends \
        nodejs \
        libvulkan1 \
        libgomp1 \
        tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app -m -d /home/app app

# Copy waifu2x binary and models from build stage
COPY --from=builder /opt/waifu2x/bin/waifu2x-ncnn-vulkan /usr/local/bin/waifu2x-ncnn-vulkan
COPY --from=builder /src/models /opt/waifu2x/models

# Install Node.js dependencies
WORKDIR /app
COPY web/package.json web/package-lock.json* /app/
RUN npm ci --omit=dev && npm cache clean --force

# Copy web app source
COPY web /app
RUN rm -rf /app/uploads /app/outputs \
    && mkdir -p /app/uploads /app/outputs \
    && chown -R app:app /app

ENV NODE_ENV=production \
    PORT=3000 \
    WAIFU2X_BIN=/usr/local/bin/waifu2x-ncnn-vulkan \
    MODELS_DIR=/opt/waifu2x/models

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT, r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
