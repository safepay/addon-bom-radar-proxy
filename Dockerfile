ARG BUILD_FROM
FROM ${BUILD_FROM}

# Set shell
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install Node.js and npm
RUN \
    apk add --no-cache \
        nodejs \
        npm

# Create app directory
WORKDIR /app

# Copy package files
COPY src/package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application files
COPY src/server.js ./
COPY src/radars.json ./

# Create cache directory with correct permissions
RUN mkdir -p /data/cache && chmod 755 /data/cache

# Copy root filesystem
COPY rootfs /

# Make run script executable
RUN chmod a+x /etc/services.d/bom-proxy/run

# Expose port
EXPOSE 3000

# Build arguments
ARG BUILD_DATE
ARG BUILD_REF
ARG BUILD_VERSION
ARG BUILD_ARCH

# Labels
LABEL \
    io.hass.name="BoM Radar Proxy" \
    io.hass.description="Bureau of Meteorology radar image proxy with caching" \
    io.hass.arch="${BUILD_ARCH}" \
    io.hass.type="addon" \
    io.hass.version=${BUILD_VERSION} \
    maintainer="safepay" \
    org.opencontainers.image.title="BoM Radar Proxy" \
    org.opencontainers.image.description="Bureau of Meteorology radar image proxy with caching" \
    org.opencontainers.image.vendor="safepay" \
    org.opencontainers.image.authors="safepay" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.url="https://github.com/safepay/addon-bom-radar-proxy" \
    org.opencontainers.image.source="https://github.com/safepay/addon-bom-radar-proxy" \
    org.opencontainers.image.documentation="https://github.com/safepay/addon-bom-radar-proxy/blob/main/README.md" \
    org.opencontainers.image.created=${BUILD_DATE} \
    org.opencontainers.image.revision=${BUILD_REF} \
    org.opencontainers.image.version=${BUILD_VERSION}
